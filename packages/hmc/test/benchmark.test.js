import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createNiftiFromData } from "@neurodesk/webapp-components/file-io/nifti";
import { benchmarkSourceHashes } from "../validation/benchmark-sources.mjs";
import { prepareBenchmark } from "../validation/benchmark-task.js";
import { loadHmcNode, gzip } from "../src/node.js";
import { IDENTITY, readSeries } from "../src/pipeline.js";
import { makeSeries, SIZE, VOLUMES } from "./synthetic.js";

test("benchmark receipts cover worker adapters, generated kernels, shared IO and added runtime files", async () => {
  const actual = await benchmarkSourceHashes();
  for (const path of ["packages/hmc/src/pool.js", "packages/hmc/src/node-worker.js", "packages/hmc/src/browser.js",
    "packages/hmc-registration/src/worker.js", "packages/hmc-registration/wasm/hmc-registration.mjs",
    "packages/components/src/file-io/NiftiUtils.js", "packages/hmc/validation/benchmark-matrix.mjs"]) assert.ok(actual[path], path);
  const root = await mkdtemp(join(tmpdir(), "hmc-source-hashes-"));
  try {
    for (const path of Object.keys(actual)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "initial");
    }
    const before = await benchmarkSourceHashes(root);
    await writeFile(join(root, "packages/hmc/src/node-worker.js"), "changed adapter");
    const changed = await benchmarkSourceHashes(root);
    assert.notDeepEqual(changed, before);
    await writeFile(join(root, "packages/hmc/src/new-runtime.js"), "new runtime");
    const added = await benchmarkSourceHashes(root);
    assert.ok(added["packages/hmc/src/new-runtime.js"]);
    assert.notDeepEqual(added, changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("benchmark verification rejects a nonfinite corrected DWI frame before hashing", async () => {
  const source = makeSeries();
  const series = await readSeries(source.nifti);
  const encoder = new TextEncoder();
  const files = {
    image: source.nifti,
    mask: createNiftiFromData(new Uint8Array(SIZE ** 3).fill(1), series.headerBytes, { dims: [SIZE, SIZE, SIZE] }),
    bval: encoder.encode(VOLUMES.map(volume => volume.bval).join(" ")),
    bvec: encoder.encode([0, 1, 2].map(axis => VOLUMES.map(volume => volume.bvec[axis]).join(" ")).join("\n")),
  };
  const hmc = await loadHmcNode();
  const runtime = {
    workers: 1,
    gzip(bytes) {
      const corrupted = new Uint8Array(bytes);
      const view = new DataView(corrupted.buffer);
      const start = view.getFloat32(108, true);
      view.setFloat32(start + SIZE ** 3 * 4, NaN, true);
      return gzip(corrupted);
    },
    spawn: () => ({
      onmessage: null, terminate() {},
      postMessage(message) {
        const outputs = message.argv[0] === "--apply"
          ? { "resampled.nii": message.inputs["volume.nii"] }
          : { "out0GenericAffine.mat": hmc.writeMat(IDENTITY) };
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, outputs } }));
      },
    }),
  };
  const task = await prepareBenchmark({ files: Object.fromEntries(Object.keys(files).map(key => [key, key])), model: "trivial", seed: 1234, fileName: "benchmark_dwi.nii.gz" }, {
    readBytes: async path => files[path], loadHmc: async () => hmc, runtime,
  });
  await task.run();
  await assert.rejects(task.verify(), /nonfinite value at voxel 32768/);
});

// The pool on worker threads with the real hmc-registration kernel, on the synthetic series of
// synthetic.js: the transforms recover the known motion, the outputs have the expected names,
// columns and b0 volumes, 1 and 4 workers write the same bytes, and a cancel stops the pool
// within one volume with no worker left.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { correctHeadMotion, readSeries } from "../src/pipeline.js";
import { loadHmcNode, nodeRuntime, spawnRegistrationThread } from "../src/node.js";
import { ARGV, SIZE, VOLUMES, expectedMotion, makeSeries, reference, sphereMask } from "./synthetic.js";

const FILE = "sub-01_ses-01_dwi.nii.gz";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function inputs() {
  const { nifti, bvals, bvecs } = makeSeries();
  return { series: await readSeries(nifti), bvals, bvecs, hmc: await loadHmcNode() };
}

/** Records every worker the pool starts, so a test can see that each one has ended. */
function recordingRuntime(workers) {
  const spawned = [];
  const runtime = nodeRuntime({
    workers,
    spawn: () => {
      const worker = spawnRegistrationThread();
      const post = worker.postMessage;
      worker.sent = 0;
      worker.postMessage = (message, transfer) => {
        worker.sent++;
        post(message, transfer);
      };
      spawned.push(worker);
      return worker;
    },
  });
  return { runtime, spawned };
}

function run({ series, bvals, bvecs, hmc }, runtime, extra = {}) {
  const target = reference();
  return correctHeadMotion({
    series,
    bvals,
    bvecs,
    method: "nifreeze",
    target: (_, b0) => (b0 ? null : target),
    argv: () => [...ARGV],
    mask: sphereMask(),
    fileName: FILE,
    sidecar: { RepetitionTime: 3 },
    hmc,
    runtime,
    ...extra,
  });
}

const results = {};

test("four workers recover the known rigid motion and write the BIDS-derivative outputs", async () => {
  const input = await inputs();
  const { runtime, spawned } = recordingRuntime(4);
  const events = [];
  const started = performance.now();
  const result = await run(input, runtime, { onProgress: (event) => events.push(event) });
  results.four = { result, seconds: (performance.now() - started) / 1000 };
  assert.equal(spawned.length, 4);
  await Promise.all(spawned.map((worker) => worker.exited));
  assert.ok(spawned.every((worker) => !worker.running));

  // b0 volumes 0 and 3 are not registered; the four others are.
  assert.deepEqual(result.b0, [true, false, false, true, false, false]);
  assert.deepEqual(result.registered, [false, true, true, false, true, true]);
  assert.equal(events.filter((e) => e.stage === "register").length, 4);
  assert.equal(events.filter((e) => e.stage === "resample").length, 4);
  assert.deepEqual(events.at(-1), { stage: "write", done: 1, total: 1 });

  const errors = [];
  result.motion.forEach((row, v) => {
    const expected = expectedMotion(VOLUMES[v]);
    row.translation.forEach((value, axis) => {
      errors.push({ v, kind: "trans", axis, error: value - expected.translation[axis] });
      assert.ok(Math.abs(value - expected.translation[axis]) < 0.1, `volume ${v} trans[${axis}] = ${value}, expected ${expected.translation[axis]}`);
    });
    row.rotation.forEach((value, axis) => {
      errors.push({ v, kind: "rot", axis, error: value - expected.rotation[axis] });
      assert.ok(Math.abs(value - expected.rotation[axis]) < 0.1 * (Math.PI / 180), `volume ${v} rot[${axis}] = ${value}, expected ${expected.rotation[axis]}`);
    });
  });
  results.errors = errors;

  const names = [
    "sub-01_ses-01_desc-hmc_dwi.nii.gz",
    "sub-01_ses-01_desc-hmc_dwi.bval",
    "sub-01_ses-01_desc-hmc_dwi.bvec",
    "sub-01_ses-01_desc-hmc_motion.tsv",
    "sub-01_ses-01_desc-hmc_dwi.json",
    ...VOLUMES.map((_, v) => `sub-01_ses-01_vol-000${v}_desc-hmc_xfm.mat`),
  ];
  assert.deepEqual(Object.keys(result.files).sort(), [...names].sort());

  const text = (name) => new TextDecoder().decode(result.files[name]);
  const tsv = text("sub-01_ses-01_desc-hmc_motion.tsv").trimEnd().split("\n").map((line) => line.split("\t"));
  assert.deepEqual(tsv[0], ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z", "framewise_displacement"]);
  assert.equal(tsv.length, 1 + VOLUMES.length);
  assert.ok(tsv.every((row) => row.length === 7));
  assert.equal(tsv[1][6], "n/a");
  assert.deepEqual(tsv[1].slice(0, 6), ["0.0", "0.0", "0.0", "0.0", "0.0", "0.0"]);

  const bvec = text("sub-01_ses-01_desc-hmc_dwi.bvec").trimEnd().split("\n").map((line) => line.split(" ").map(Number));
  assert.equal(bvec.length, 3);
  assert.ok(bvec.every((row) => row.length === VOLUMES.length));
  // The b0 columns are kept unchanged; volume 4 moved by +4 degrees about z, so its b-vector
  // (1, 0, 0) turns by -4 degrees in the reference frame.
  assert.deepEqual([bvec[0][0], bvec[1][0], bvec[2][0]], [0, 0, 0]);
  assert.ok(Math.abs(bvec[0][4] - Math.cos(4 * (Math.PI / 180))) < 1e-4, `bvec x ${bvec[0][4]}`);
  assert.ok(Math.abs(bvec[1][4] + Math.sin(4 * (Math.PI / 180))) < 0.004, `bvec y ${bvec[1][4]}`);
  assert.equal(text("sub-01_ses-01_desc-hmc_dwi.bval"), "0.00 1000.00 1000.00 0.00 1000.00 1000.00\n");

  const sidecar = JSON.parse(text("sub-01_ses-01_desc-hmc_dwi.json"));
  assert.equal(sidecar.RepetitionTime, 3);
  assert.equal(sidecar.HeadMotionCorrection.RegisteredVolumes, 4);

  // The b0 volumes are the input voxels; each corrected DWI volume is near the reference.
  const image = readNiftiFrames(gunzipSync(result.files["sub-01_ses-01_desc-hmc_dwi.nii.gz"]));
  assert.equal(image.frames, VOLUMES.length);
  assert.equal(image.header.datatype, 16);
  const voxels = SIZE ** 3;
  const { series } = await inputs();
  for (const v of [0, 3]) assert.deepEqual(image.data.subarray(v * voxels, (v + 1) * voxels), series.data.subarray(v * voxels, (v + 1) * voxels));
  const target = reference();
  const peak = Math.max(...target);
  const central = (values) => {
    let worst = 0;
    for (let k = 8; k < 24; k++) for (let j = 8; j < 24; j++) for (let i = 8; i < 24; i++) {
      const n = i + SIZE * (j + SIZE * k);
      worst = Math.max(worst, Math.abs(values[n] - target[n]));
    }
    return worst / peak;
  };
  results.residual = [];
  for (const v of [1, 2, 4, 5]) {
    const before = central(series.data.subarray(v * voxels, (v + 1) * voxels));
    const after = central(image.data.subarray(v * voxels, (v + 1) * voxels));
    results.residual.push({ v, before, after });
    assert.ok(after < 0.03, `volume ${v}: residual ${after} of the peak after correction (before ${before})`);
  }
});

test("one worker writes the same bytes as four", async () => {
  assert.ok(results.four, "the four-worker test ran first");
  const { runtime, spawned } = recordingRuntime(1);
  const started = performance.now();
  const one = await run(await inputs(), runtime);
  results.oneSeconds = (performance.now() - started) / 1000;
  assert.equal(spawned.length, 1);
  const four = results.four.result.files;
  assert.deepEqual(Object.keys(one.files).sort(), Object.keys(four).sort());
  for (const name of Object.keys(four)) assert.equal(sha256(one.files[name]), sha256(four[name]), name);
});

test("a cancel stops the pool within one volume and leaves no worker running", async () => {
  const { runtime, spawned } = recordingRuntime(1);
  const controller = new AbortController();
  const events = [];
  let abortedAt = 0;
  const started = performance.now();
  const outcome = run(await inputs(), runtime, {
    signal: controller.signal,
    onProgress: (event) => {
      events.push({ ...event, aborted: controller.signal.aborted });
      if (event.stage === "register" && !controller.signal.aborted) {
        abortedAt = performance.now();
        controller.abort();
      }
    },
  });
  await assert.rejects(outcome, { name: "AbortError" });
  const stopMs = performance.now() - abortedAt;
  const firstVolumeMs = abortedAt - started;
  results.cancel = { stopMs, firstVolumeMs };
  // Nothing was reported after the abort: the volume in flight did not finish.
  assert.equal(events.filter((e) => e.aborted).length, 0);
  assert.equal(events.length, 1);
  // The worker had received the second volume's registration when the abort came: a run in
  // progress was terminated, and no third run was sent.
  assert.equal(spawned[0]?.sent, 2);
  assert.equal(spawned.length, 1);
  await Promise.all(spawned.map((worker) => worker.exited));
  assert.ok(spawned.every((worker) => !worker.running));
  assert.ok(stopMs < firstVolumeMs, `stopped ${stopMs} ms after the abort; one volume took ${firstVolumeMs} ms`);
});

test.after(() => {
  if (!results.four) return;
  const worst = (kind) => Math.max(...results.errors.filter((e) => e.kind === kind).map((e) => Math.abs(e.error)));
  console.log(
    JSON.stringify({
      seconds4: Number(results.four.seconds.toFixed(2)),
      seconds1: results.oneSeconds && Number(results.oneSeconds.toFixed(2)),
      worstTranslationErrorMm: worst("trans"),
      worstRotationErrorDeg: (worst("rot") * 180) / Math.PI,
      residual: results.residual,
      cancel: results.cancel,
    }),
  );
});

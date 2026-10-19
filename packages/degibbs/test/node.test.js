import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { checkInstallation, companions, parseAxes, parseSettings, removeRinging } from "../src/node.js";
import { loadDegibbs } from "../src/wasm.js";

const bin = fileURLToPath(new URL("../bin/degibbs.js", import.meta.url));
const scratch = () => mkdtemp(join(process.env.TMPDIR || tmpdir(), "degibbs-node-"));

// Two volumes whose axial slices hold a sharp-edged square, the second at twice the intensity.
function series({ nx = 16, ny = 12, nz = 3, frames = 2 } = {}) {
  const voxels = nx * ny * nz;
  const data = new Float32Array(voxels * frames);
  for (let f = 0; f < frames; f++) {
    for (let z = 0; z < nz; z++) {
      for (let y = 3; y < 9; y++) {
        for (let x = 4; x < 12; x++) data[f * voxels + x + nx * (y + ny * z)] = 100 * (f + 1);
      }
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, nx, ny, nz, frames, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] } });
  return { nifti: Buffer.from(createNiftiFromData(data, header, { dims: [nx, ny, nz, frames] })), data, dims: [nx, ny, nz], frames };
}

async function writeSeries(dir, name = "sub-01_dwi") {
  const input = series();
  await writeFile(join(dir, `${name}.nii.gz`), gzipSync(input.nifti));
  await writeFile(join(dir, `${name}.bval`), "0 1000\n");
  await writeFile(join(dir, `${name}.bvec`), "0 1\n0 0\n0 0\n");
  return { ...input, image: join(dir, `${name}.nii.gz`) };
}

test("writes the web app's four downloads, each volume corrected as the app's workers do", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    const out = join(dir, "out");
    const result = await removeRinging({ input: input.image, output: out });
    assert.deepEqual((await readdir(out)).sort(), [
      "sub-01_desc-degibbs_dwi.bval",
      "sub-01_desc-degibbs_dwi.bvec",
      "sub-01_desc-degibbs_dwi.json",
      "sub-01_desc-degibbs_dwi.nii.gz",
    ]);
    assert.equal(await readFile(join(out, "sub-01_desc-degibbs_dwi.bval"), "utf8"), "0 1000\n");
    assert.equal(await readFile(join(out, "sub-01_desc-degibbs_dwi.bvec"), "utf8"), "0 1\n0 0\n0 0\n");
    const sidecar = await readFile(join(out, "sub-01_desc-degibbs_dwi.json"), "utf8");
    assert.match(sidecar, /mrdegibbs 3\.0\.8 port/);
    assert.ok(sidecar.endsWith("}\n"));

    const { degibbs } = await loadDegibbs(readFile(new URL("../src/degibbs.wasm", import.meta.url)));
    const voxels = input.dims[0] * input.dims[1] * input.dims[2];
    const expected = new Float32Array(input.data.length);
    for (let f = 0; f < input.frames; f++) expected.set(degibbs(input.data.slice(f * voxels, (f + 1) * voxels), input.dims), f * voxels);
    const written = gunzipSync(await readFile(join(out, "sub-01_desc-degibbs_dwi.nii.gz")));
    assert.deepEqual(Buffer.from(written), Buffer.from(createNiftiFromData(expected, input.nifti.buffer.slice(input.nifti.byteOffset), { dims: [...input.dims, input.frames] })));
    assert.deepEqual(readNiftiFrames(written.buffer.slice(written.byteOffset)).frames, 2);
    assert.deepEqual(result.provenance.sliceAxes, [0, 1]);
    assert.equal(result.provenance.method, "mrdegibbs-3.0.8-port");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the sidecar's SliceEncodingDirection sets the axes and its fields are kept", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    await writeFile(join(dir, "sub-01_dwi.json"), JSON.stringify({ SliceEncodingDirection: "j", TotalReadoutTime: 0.05 }));
    const out = join(dir, "out");
    const result = await removeRinging({ input: input.image, output: out });
    assert.deepEqual(result.provenance.sliceAxes, [0, 2]);
    const sidecar = JSON.parse(await readFile(join(out, "sub-01_desc-degibbs_dwi.json"), "utf8"));
    assert.equal(sidecar.TotalReadoutTime, 0.05);
    assert.match(sidecar.Description, /subvoxel/);
    assert.deepEqual((await removeRinging({ input: input.image, output: join(dir, "out2"), axes: "1,2" })).provenance.sliceAxes, [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pairs gradient files by stem unless others are named, and needs none", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    assert.deepEqual(await companions(input.image), { bval: join(dir, "sub-01_dwi.bval"), bvec: join(dir, "sub-01_dwi.bvec"), json: null });
    await writeFile(join(dir, "bvals"), "0 2000\n");
    assert.equal((await companions(input.image, { bval: join(dir, "bvals") })).bval, join(dir, "bvals"));
    await assert.rejects(companions(input.image, { bvec: join(dir, "missing") }), /does not exist/);
    await mkdir(join(dir, "alone"));
    await writeFile(join(dir, "alone", "t1.nii"), series({ frames: 1 }).nifti);
    const out = join(dir, "out");
    await removeRinging({ input: join(dir, "alone", "t1.nii"), output: out });
    assert.deepEqual((await readdir(out)).sort(), ["t1_desc-degibbs.json", "t1_desc-degibbs.nii.gz"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses a non-empty output, a non-NIfTI input and bad settings", async () => {
  const dir = await scratch();
  try {
    const input = await writeSeries(dir);
    await assert.rejects(removeRinging({ input: input.image, output: dir }), /not empty/);
    await assert.rejects(removeRinging({ input: join(dir, "sub-01_dwi.bval"), output: join(dir, "o") }), /not a NIfTI image/);
    assert.throws(() => parseAxes("0,0"), /--axes must be one of 0,1, 0,2, 1,2/);
    assert.deepEqual(parseAxes(undefined, { SliceEncodingDirection: "i-" }), [1, 2]);
    assert.deepEqual(parseSettings({}), { nshifts: 20, minW: 1, maxW: 3 });
    assert.throws(() => parseSettings({ nshifts: "2.5" }), /--nshifts must be a positive whole number/);
    assert.throws(() => parseSettings({ minW: "3", maxW: "3" }), /must be below --max-w/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the executable prints help, passes self-check and reports errors", async () => {
  assert.match(spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" }).stdout, /Usage: degibbs IMAGE/);
  const self = spawnSync(process.execPath, [bin, "self-check"], { encoding: "utf8" });
  assert.equal(self.status, 0, self.stderr);
  assert.match(JSON.parse(self.stdout).phantom, /flat image unchanged/);
  assert.match((await checkInstallation()).phantom, /square voxels corrected/);
  const bad = spawnSync(process.execPath, [bin, "only-one"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Give a NIfTI image and a new output directory/);
  assert.match(spawnSync(process.execPath, [bin, "download-models"], { encoding: "utf8" }).stdout, /0 model files/);
});

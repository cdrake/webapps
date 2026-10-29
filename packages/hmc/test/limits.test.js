import assert from "node:assert/strict";
import test from "node:test";
import { estimatorBytes, nifreezeInputProblem } from "../src/limits.js";
import { correctNiFreeze } from "../src/nifreeze.js";
import { loadHmcNode } from "../src/node.js";

// Inputs measured in hmc.wasm for #452 (plan section 6): ds005577's 120 × 120 × 75 grid with
// slices repeated, frames repeated, or wider masks. `passed` is what the estimator did.
const measured = [
  { name: "ds005577 reference", voxels: 1080000, frames: 101, dwiVolumes: 90, maskVoxels: 161668, passed: true },
  { name: "94 slices, largest split that passed", voxels: 1353600, frames: 101, dwiVolumes: 90, maskVoxels: 202042, passed: true },
  { name: "98 slices", voxels: 1411200, frames: 101, dwiVolumes: 90, maskVoxels: 210209, passed: false },
  { name: "202 frames", voxels: 1080000, frames: 202, dwiVolumes: 180, maskVoxels: 161679, passed: false },
  { name: "reference grid, largest mask that passed", voxels: 1080000, frames: 101, dwiVolumes: 90, maskVoxels: 373717, passed: true },
  { name: "reference grid, wider mask", voxels: 1080000, frames: 101, dwiVolumes: 90, maskVoxels: 395137, passed: false },
  { name: "half grid, 202 frames, wider mask", voxels: 547200, frames: 202, dwiVolumes: 180, maskVoxels: 227289, passed: false },
  { name: "quarter grid, 404 frames", voxels: 273600, frames: 404, dwiVolumes: 360, maskVoxels: 135294, passed: false },
];

for (const { name, passed, ...input } of measured) {
  test(`the limit ${passed ? "accepts" : "refuses"} the measured ${name}`, () => {
    assert.equal(nifreezeInputProblem(input) === null, passed);
  });
}

test("the series limit applies before a mask exists and the fit limit only to GP", () => {
  const reference = { voxels: 1080000, frames: 101, dwiVolumes: 90 };
  assert.equal(estimatorBytes(reference).fit, 0);
  assert.equal(nifreezeInputProblem(reference), null);
  assert.match(nifreezeInputProblem({ ...reference, voxels: 1411200 }), /^Series too large for motion correction \(1\.09 of 1\.05 GB/);
  const wide = { ...reference, maskVoxels: 1069861 };
  assert.match(nifreezeInputProblem(wide), /^Brain mask too large for the GP model/);
  assert.equal(nifreezeInputProblem({ ...wide, model: "trivial" }), null);
});

test("correctNiFreeze refuses an oversized series before the estimator allocates it", async () => {
  const hmc = await loadHmcNode();
  const frames = 202;
  const series = { dims: [120, 120, 75], frames, data: new Float32Array(0) };
  const bvals = Array.from({ length: frames }, (_, i) => i % 10 ? 1000 : 0);
  const bvecs = [bvals.map(b => b ? 1 : 0), bvals.map(() => 0), bvals.map(() => 0)];
  await assert.rejects(correctNiFreeze({ series, bvals, bvecs, mask: null, hmc, model: "trivial" }), /^Error: Series too large for motion correction/);
});

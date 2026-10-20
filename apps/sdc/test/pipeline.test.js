import { test } from "node:test";
import assert from "node:assert/strict";
import { b0Frames, bidsStem, fieldSidecar, meanFrames, outputNames, sameAffine, selectPair, voxelSizes } from "../src/pipeline.js";

const entry = (name, pe, bval = null) => ({ image: { name }, sidecar: pe ? { PhaseEncodingDirection: pe, TotalReadoutTime: 0.04 } : null, bval });

test("the DWI series is image 1, otherwise the first by name", () => {
  const [first, second] = selectPair([entry("sub-01_dir-PA_epi.nii.gz", "j"), entry("sub-01_dir-AP_dwi.nii.gz", "j-", {})]);
  assert.equal(first.image.name, "sub-01_dir-AP_dwi.nii.gz");
  assert.equal(second.image.name, "sub-01_dir-PA_epi.nii.gz");
  const [a] = selectPair([entry("b_epi.nii.gz", "j"), entry("a_epi.nii.gz", "j-")]);
  assert.equal(a.image.name, "a_epi.nii.gz");
});

test("pairs are refused unless the directions are opposite on one in-plane axis", () => {
  assert.throws(() => selectPair([entry("a.nii.gz", "j"), entry("b.nii.gz", "j")]), /opposite directions/);
  assert.throws(() => selectPair([entry("a.nii.gz", "i"), entry("b.nii.gz", "j-")]), /opposite directions/);
  assert.throws(() => selectPair([entry("a.nii.gz", "k"), entry("b.nii.gz", "k-")]), /must be i, i-, j or j-/);
  assert.throws(() => selectPair([entry("a.nii.gz", "j"), entry("b.nii.gz", null)]), /this selection has 1\. b\.nii\.gz has no sidecar/);
  assert.throws(() => selectPair([entry("a.nii.gz", "j"), entry("b.nii.gz", "j-"), entry("c.nii.gz", "j")]), /this selection has 3/);
});

test("b = 0 volumes come from the bval, or are all volumes without one", () => {
  assert.deepEqual(b0Frames(null, 3), [0, 1, 2]);
  assert.deepEqual(b0Frames("0 5 1000 50 2000\n", 5), [0, 1, 3]);
  assert.throws(() => b0Frames("0 1000", 3), /2 values for 3 volumes/);
  assert.throws(() => b0Frames("1000 2000", 2), /no volume with b ≤ 50/);
});

test("the mean averages the chosen volumes voxel by voxel", () => {
  const data = Float32Array.from([1, 2, 10, 20, 3, 4]);
  assert.deepEqual(Array.from(meanFrames(data, 2, [0, 2])), [2, 3]);
});

test("voxel sizes are the affine's column lengths", () => {
  const affine = [[0, -2, 0, 10], [2, 0, 0, 0], [0, 0, 2.5, 0]];
  assert.deepEqual(voxelSizes(affine), [2, 2, 2.5]);
  assert.ok(sameAffine(affine, affine.map((row) => row.map((v) => v + 1e-5))));
  assert.ok(!sameAffine(affine, affine.map((row) => row.map((v) => v + 0.1))));
});

test("outputs are named from image 1's BIDS stem", () => {
  assert.equal(bidsStem("sub-01_desc-preproc_dir-AP_dwi.nii.gz"), "sub-01_dir-AP");
  assert.deepEqual(outputNames("sub-01_dir-AP_dwi.nii.gz", "sub-01_dir-PA_epi.nii.gz"), {
    field: "sub-01_dir-AP_fieldmap.nii.gz",
    sidecar: "sub-01_dir-AP_fieldmap.json",
    corrected1: "sub-01_dir-AP_desc-pyhyscoQC_b0.nii.gz",
    corrected2: "sub-01_dir-PA_desc-pyhyscoQC_b0.nii.gz",
  });
  assert.equal(outputNames("b0.nii", "b0.nii.gz").corrected2, "b0_rev_desc-pyhyscoQC_b0.nii.gz");
  const meta = fieldSidecar({ image1: "a.nii.gz", image2: "b.nii.gz", phaseEncodingDirection: "j-", totalReadoutTime: 0.04, iterations: 5 });
  assert.equal(meta.Units, "Hz");
  assert.deepEqual(meta.Sources, ["a.nii.gz", "b.nii.gz"]);
});

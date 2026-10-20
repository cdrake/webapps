// What a rigid registration of test/data/moving.nii to test/data/fixed.nii must give, in Node and
// in a browser worker.
import assert from "node:assert/strict";
import { SHIFT_RAS } from "../scripts/make-test-data.mjs";

export const ARGV = Object.freeze([
  "--dimensionality", "3", "--float", "1", "--random-seed", "1234",
  "--transform", "Rigid[0.1]",
  "--metric", "Mattes[fixed.nii,moving.nii,1,32,Regular,0.25]",
  "--convergence", "[100x50,1e-6,10]", "--shrink-factors", "2x1", "--smoothing-sigmas", "1x0vox",
  "--output", "[out]",
]);

// ITK works in LPS, so the RAS shift changes sign on x and y. The transform maps fixed points to
// moving points, so its translation is the shift itself.
export const SHIFT_LPS = Object.freeze([-SHIFT_RAS[0], -SHIFT_RAS[1], SHIFT_RAS[2]]);

// SHA-256 of out0GenericAffine.mat from native antsRegistration at ANTs 52bc0ab (SuperBuild,
// Release, ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1) with ARGV. The WebAssembly kernel writes the same bytes.
export const NATIVE_MAT_SHA256 = "43d38f061db2fd34668d07f99fe5d8494b1fbdf2a8719ae48de5ea2d14c76509";

/** Asserts that a transform read by readMatTransform is the known rigid shift. */
export function assertRecoversShift({ transform, parameters, fixed }) {
  assert.equal(transform, "AffineTransform_float_3_3");
  assert.equal(parameters.length, 12);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  parameters.slice(0, 9).forEach((value, i) => assert.ok(Math.abs(value - identity[i]) < 0.005, `matrix[${i}] = ${value}`));
  // The centre is the grid centre, the origin, so the translation is the offset itself.
  assert.deepEqual(fixed, [0, 0, 0]);
  parameters.slice(9).forEach((value, axis) => assert.ok(Math.abs(value - SHIFT_LPS[axis]) < 0.05, `translation[${axis}] = ${value}, expected ${SHIFT_LPS[axis]}`));
}

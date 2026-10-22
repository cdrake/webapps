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

// SHA-256 of out0GenericAffine.mat from native antsRegistration with ARGV and --random-seed 4321.
export const NATIVE_MAT_SEED_4321_SHA256 = "733124b497ac7baa3f08d37616ec53e8549c16249496680040975a7561567efe";

// The interpolators --apply takes, as antsApplyTransforms names them.
export const INTERPOLATIONS = Object.freeze(["Linear", "NearestNeighbor", "BSpline", "BSpline[5]", "HammingWindowedSinc", "LanczosWindowedSinc"]);

// SHA-256 of each file that native ANTs at 52bc0ab (validation/native-reference.sh) writes from
// test/data. The WebAssembly kernel writes the same bytes: a tolerance of 0, inside the 1e-5
// relative limit of #445. apply-<name>.nii is antsApplyTransforms in its default double precision
// with -u float; with --float 1 native ANTs differs from it by at most 5.1e-7 of the image maximum.
export const NATIVE_SHA256 = Object.freeze({
  "average.mat": "c4240c5c2e3c70bbb6c3c2d4695f4c84649958d7decc224474fcb3b98c86a9a8",
  "apply-Linear.nii": "3ee934f440d4b70b277d27b4822f2c6ad22ef6b5612b6c326bbb6f6c4771e40d",
  "apply-NearestNeighbor.nii": "c66dd756445d9594848c7214c1611bc8f9b95bc513a64bcff34975612c75a5ac",
  "apply-BSpline.nii": "5aa7e94c19da8a9563e274dd8be3aedb162b2733f0a2d0e697d7153e45138d97",
  "apply-BSpline5.nii": "6b8d23a32b0df66a5eac233d3590f2144c025a5f54245a16f2c7783c50e1cc35",
  "apply-HammingWindowedSinc.nii": "da6756e9d72461a20b4b77e7ef048c0014498e40a29ecb93de23c7f2f57aaf96",
  "apply-LanczosWindowedSinc.nii": "7cca5d90ecb01bf7fe709b52fe071c7ae311c31d2ee5a45352a33df40658a826",
  "apply-inverse-HammingWindowedSinc.nii": "e863aae0bf239b9ee0d9e2818ce945f0af66012d408b2e3eaa61d3f5cc4eebdf",
  "average-0.nii": "1e55cbfa4d50a5900969aceefe7970c4c638edc15890a237cb9aa72224099902",
  "average-1.nii": "68d441ac04e10259567666e66887ba3e59459b7b604e639d88f011dce3139846",
});

const withSeed = (seed) => ARGV.map((token, i) => (ARGV[i - 1] === "--random-seed" ? seed : token));

/**
 * The steps of validation/native-reference.sh, through `run(argv, inputs) -> outputs`: two
 * registrations, AverageAffineTransform, --apply with each interpolator and through the inverse
 * of the average (the SHORELine template step), and AverageImages without and with normalization.
 * @returns {Promise<Record<string, Uint8Array>>} every file named in NATIVE_SHA256, and the two registrations
 */
export async function runNativeReferenceSteps(run, { fixed, moving }) {
  const pair = () => ({ "fixed.nii": fixed, "moving.nii": moving });
  const files = {};
  for (const seed of ["1234", "4321"]) {
    const outputs = await run(withSeed(seed).map((token) => (token === "[out]" ? `[seed${seed}]` : token)), pair());
    files[`seed${seed}0GenericAffine.mat`] = outputs[`seed${seed}0GenericAffine.mat`];
  }
  const average = await run(["AverageAffineTransform", "3", "average.mat", "a.mat", "b.mat"], {
    "a.mat": files["seed12340GenericAffine.mat"],
    "b.mat": files["seed43210GenericAffine.mat"],
  });
  files["average.mat"] = average["average.mat"];
  for (const interpolation of INTERPOLATIONS) {
    const name = `apply-${interpolation.replace(/[[\]]/g, "")}.nii`;
    const outputs = await run(["--apply", "fixed.nii", "moving.nii", name, interpolation, "0", "t.mat"], { ...pair(), "t.mat": files["seed12340GenericAffine.mat"] });
    files[name] = outputs[name];
  }
  const inverseName = "apply-inverse-HammingWindowedSinc.nii";
  const inverse = await run(["--apply", "fixed.nii", "moving.nii", inverseName, "HammingWindowedSinc", "0", "inverse:average.mat"], {
    ...pair(),
    "average.mat": files["average.mat"],
  });
  files[inverseName] = inverse[inverseName];
  for (const normalize of ["0", "1"]) {
    const name = `average-${normalize}.nii`;
    const outputs = await run(["AverageImages", "3", name, normalize, "fixed.nii", "apply-Linear.nii"], { "fixed.nii": fixed, "apply-Linear.nii": files["apply-Linear.nii"] });
    files[name] = outputs[name];
  }
  return files;
}

/** The voxels of a NIfTI-1 file with int16 or float32 data, as numbers. */
export function niftiVoxels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getFloat32(108, true);
  const type = view.getInt16(70, true);
  const count = [1, 2, 3].reduce((product, axis) => product * view.getInt16(40 + 2 * axis, true), 1);
  const size = { 4: 2, 16: 4 }[type];
  if (!size) throw new Error(`Unsupported NIfTI datatype ${type}.`);
  return Array.from({ length: count }, (_, i) => (type === 4 ? view.getInt16(offset + 2 * i, true) : view.getFloat32(offset + 4 * i, true)));
}

/** max |a - b| / max |b| over the central 16^3 voxels of two 32^3 volumes. */
export function centralRelativeError(a, b) {
  let difference = 0;
  let maximum = 0;
  for (let k = 8; k < 24; k++) {
    for (let j = 8; j < 24; j++) {
      for (let i = 8; i < 24; i++) {
        const index = i + 32 * (j + 32 * k);
        difference = Math.max(difference, Math.abs(a[index] - b[index]));
        maximum = Math.max(maximum, Math.abs(b[index]));
      }
    }
  }
  return difference / maximum;
}

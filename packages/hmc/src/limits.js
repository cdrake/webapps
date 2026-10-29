// What hmc.wasm's estimator can hold. Its linear memory stops at 1 GiB (scripts/build-wasm.sh),
// whatever the machine has, so an input over these limits fails with a bare "unreachable".
// The two stages and their limits are measured (docs/architecture/dwi-hmc-plan.md, section 6):
//   split: the copied series and its float32 DWI volumes, 4·V·(frames + DWI) + 9·V bytes; the
//          largest that passed needed 1.046 GB, the smallest that failed 1.091 GB.
//   fit:   the DWI volumes kept, plus one GP fit over the mask, 4·V·DWI + 9·V + 16·M·(DWI − 1)
//          bytes; every measured failure needed over 0.96 GB; 0.931 GB passed on the reference grid.

const GB = 1e9;
export const ESTIMATOR_LIMITS = Object.freeze({ split: 1.05 * GB, fit: 0.94 * GB });

/** Estimated estimator bytes for each stage. `maskVoxels` is null until the mask is known. */
export function estimatorBytes({ voxels, frames, dwiVolumes, maskVoxels = null, model = "gp" }) {
  return {
    split: 4 * voxels * (frames + dwiVolumes) + 9 * voxels,
    fit: model === "gp" && maskVoxels !== null ? 4 * voxels * dwiVolumes + 9 * voxels + 16 * maskVoxels * (dwiVolumes - 1) : 0,
  };
}

const gb = bytes => (bytes / GB).toFixed(2);

/** Why NiFreeze cannot run on this input, or null. Upper bounds for the mask voxels are safe. */
export function nifreezeInputProblem(input) {
  const bytes = estimatorBytes(input);
  if (bytes.split > ESTIMATOR_LIMITS.split) {
    return `Series too large for motion correction (${gb(bytes.split)} of ${gb(ESTIMATOR_LIMITS.split)} GB model memory): crop it or use fewer volumes.`;
  }
  if (bytes.fit > ESTIMATOR_LIMITS.fit) {
    return `Brain mask too large for the GP model (${gb(bytes.fit)} of ${gb(ESTIMATOR_LIMITS.fit)} GB model memory): use a tighter mask or mean b0.`;
  }
  return null;
}

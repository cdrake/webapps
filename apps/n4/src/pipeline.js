// DOM-free steps of the n4 workflow: the b0 mean and BIDS derivative names.
// The naming rules are the DWI apps' shared module.

import { maskName, outputNames as stepNames, sourceStem } from "@neurodesk/webapp-components/file-io/bids-derivatives";

/** The b0 volumes of a series (b < 50 s/mm²), or every volume of a series without b-values. */
export function b0Volumes(bvals, frames) {
  if (!bvals) return Array.from({ length: frames }, (_, i) => i);
  if (!bvals.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("The bval file must contain finite non-negative b-values.");
  }
  const b0 = bvals.map((b, i) => (b < 50 ? i : -1)).filter((i) => i >= 0);
  if (!b0.length) throw new Error("The bval file lists no b0 volume (b < 50 s/mm²) to estimate the bias field from.");
  return b0;
}

/** Mean of the given volumes, voxel by voxel. `data` is frame-major. */
export function meanVolumes(data, voxels, volumes) {
  const mean = new Float32Array(voxels);
  for (const v of volumes) {
    const offset = v * voxels;
    for (let i = 0; i < voxels; i++) mean[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) mean[i] /= volumes.length;
  return mean;
}

/** Derivative names for the corrected image, the bias field, the mask and passed-through files. */
export function outputNames(fileName) {
  const stem = sourceStem(fileName);
  const { image, bval, bvec, sidecar } = stepNames(fileName, "n4");
  return { image, bias: `${stem}_desc-n4_biasfield.nii.gz`, mask: maskName(stem), bval, bvec, sidecar };
}

// DOM-free steps of the n4 workflow: its BIDS derivative names, from the DWI apps' shared module.
// The b0 selection is @neurodesk/dwi2trx/gradients' and the mean b0 the shared meanVolumes.

import { maskName, outputNames as stepNames, sourceStem } from "@neurodesk/webapp-components/file-io/bids-derivatives";

/** Derivative names for the corrected image, the bias field, the mask and passed-through files. */
export function outputNames(fileName) {
  const stem = sourceStem(fileName);
  const { image, bval, bvec, sidecar } = stepNames(fileName, "n4");
  return { image, bias: `${stem}_desc-n4_biasfield.nii.gz`, mask: maskName(stem), bval, bvec, sidecar };
}

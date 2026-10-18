// DOM-free steps of the degibbs workflow: input pairing and BIDS derivative names.

/** The BIDS stem and suffix of an image name: sub-01_dwi.nii.gz gives ["sub-01", "dwi"]. */
export function splitName(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  return match ? [match[1], match[2]] : [base, ""];
}

/** The derivative name of the corrected image and of its passed-through gradient files. */
export function outputNames(fileName) {
  const [stem, suffix] = splitName(fileName);
  const sourceStem = stem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
  const base = suffix ? `${sourceStem}_desc-degibbs_${suffix}` : `${sourceStem}_desc-degibbs`;
  return { image: `${base}.nii.gz`, bval: `${base}.bval`, bvec: `${base}.bvec`, sidecar: `${base}.json` };
}

/** The sidecar of a corrected image: the input's, with the step recorded as BIDS derivatives do. */
export function derivativeSidecar(sidecar) {
  return { ...(sidecar ?? {}), Description: "Gibbs-ringing removal by local subvoxel shifts (MRtrix mrdegibbs 3.0.8 port)" };
}

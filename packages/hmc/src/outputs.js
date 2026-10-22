// BIDS-derivative names and the sidecar of the head-motion correction outputs.
// The shared naming module of #413 is not merged yet, so the names are written here, in the
// same form as the degibbs and dwidenoise outputs (`<source entities>_desc-<step>_<suffix>`).
// Replace these functions with the shared module when it lands, with the same names.

/** The registration and resampling this package runs, for the sidecar. */
export const SOFTWARE = Object.freeze({
  registration: "ANTs antsRegistration 52bc0ab (2.6.2) --float 1, WebAssembly (@neurodesk/hmc-registration)",
  resampling: "ANTs 52bc0ab antsApplyTransforms-style --apply, WebAssembly (@neurodesk/hmc-registration)",
});

/** The interpolator of the one resampling: cubic B-spline, the nearest to NiFreeze's SciPy order-3 spline. */
export const INTERPOLATION = "BSpline";

const METHOD_DESCRIPTIONS = Object.freeze({
  nifreeze: "NiFreeze 3bcfb00 rules (b0 volumes b <= 50 not registered; b-vectors rotated by inv(A) inv(M) A, %.6f)",
  shoreline: "QSIPrep 26.1.1 SHORELine rules (b0 volumes b < 100; b-vectors rotated by the inverse affine, renormalised, %.8f)",
});

/** Splits "sub-01_dwi.nii.gz" into ["sub-01", "dwi"]; a name without a suffix gives [name, ""]. */
export function splitName(fileName) {
  const base = String(fileName).replace(/^.*\//, "").replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  return match ? [match[1], match[2]] : [base, ""];
}

/**
 * The derivative names of one corrected series. `transform(volume)` is the ITK .mat of a
 * volume (0-based index, four digits): `<source>_vol-0003_desc-hmc_xfm.mat`.
 */
export function outputNames(fileName) {
  const [stem, suffix] = splitName(fileName);
  const source = stem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
  const base = `${source}_desc-hmc_${suffix || "dwi"}`;
  return {
    image: `${base}.nii.gz`,
    bval: `${base}.bval`,
    bvec: `${base}.bvec`,
    sidecar: `${base}.json`,
    motion: `${source}_desc-hmc_motion.tsv`,
    transform: (volume) => `${source}_vol-${String(volume).padStart(4, "0")}_desc-hmc_xfm.mat`,
  };
}

/**
 * The sidecar of the corrected series: the input's, with the step recorded. It holds no time
 * or host, so two runs on the same input write the same bytes.
 */
export function derivativeSidecar(sidecar, { method, interpolation = INTERPOLATION, registered, volumes }) {
  return {
    ...(sidecar ?? {}),
    Description: "Head-motion correction: one rigid or affine ITK transform per volume, applied in one resampling; b0 volumes kept",
    HeadMotionCorrection: {
      Method: METHOD_DESCRIPTIONS[method] ?? method,
      Registration: SOFTWARE.registration,
      Resampling: `${SOFTWARE.resampling}, ${interpolation}`,
      Volumes: volumes,
      RegisteredVolumes: registered,
    },
  };
}

/** The sidecar text: two-space JSON and a final newline. */
export function sidecarText(sidecar) {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

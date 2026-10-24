// The b-value rules of @neurodesk/dwi2trx/gradients (parseBval, b0Volumes), copied here so the
// portable n4 archive does not ship @neurodesk/dwi2trx and its vendored niimath build.
// test/gradients.test.js holds this copy to dwi2trx's results and to the gradients crate's b0
// cases. Import them from @neurodesk/webapp-components/file-io/gradients once that module exists.

/** A volume with b below this value (s/mm²) is a b0, as FSL dtifit and the gradients crate count them. */
export const B0_THRESHOLD = 50;

/** Whitespace-separated numbers from one line or a whole file. */
function parseNumbers(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

/**
 * Parses and validates an FSL bval file: non-empty, finite, non-negative b-values. With `frames`,
 * the file must list one b-value per volume of the image. Throws an Error a user can act on.
 * @returns {number[]}
 */
export function parseBval(bvalText, frames) {
  const bvals = parseNumbers(bvalText);
  if (bvals.length === 0) throw new Error("bval file is empty.");
  if (!bvals.every(Number.isFinite)) throw new Error("bval contains non-numeric or non-finite values.");
  if (bvals.some((b) => b < 0)) throw new Error("bval contains negative values.");
  if (frames !== undefined && bvals.length !== frames) throw new Error(`The image has ${frames} volumes but the bval file lists ${bvals.length}.`);
  return bvals;
}

/**
 * The b0 volumes of a series, or every volume of a series without b-values (`bvals` null).
 * Throws when a b-value is not finite and non-negative, or when no volume is a b0.
 * @returns {number[]}
 */
export function b0Volumes(bvals, frames) {
  if (!bvals) return Array.from({ length: frames }, (_, i) => i);
  if (!bvals.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("The bval file must contain finite non-negative b-values.");
  }
  const b0 = bvals.flatMap((b, i) => (b < B0_THRESHOLD ? [i] : []));
  if (!b0.length) throw new Error(`The bval file lists no b0 volume (b < ${B0_THRESHOLD} s/mm²).`);
  return b0;
}

// FSL diffusion gradients: a bval row of V b-values and a bvec file of three rows of V values.
// The b0 rule is the one of the exes/dwi/gradients crate (`B0_THRESHOLD`, `Gradients::is_b0`).

/** A volume with b below this value (s/mm²) is a b0, as FSL dtifit and the gradients crate count them. */
export const B0_THRESHOLD = 50;

/** Whitespace-separated numbers from one line or a whole file. */
export function parseNumbers(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map(Number);
}

/**
 * Parses and validates an FSL bval file: non-empty, finite, non-negative b-values. With `frames`,
 * the file must list one b-value per volume of the image. Throws an Error a user can act on.
 * @returns {number[]}
 */
export function parseBval(bvalText, frames) {
  const bvals = parseNumbers(bvalText);
  if (bvals.length === 0) throw new Error('bval file is empty.');
  if (!bvals.every(Number.isFinite)) throw new Error('bval contains non-numeric or non-finite values.');
  if (bvals.some((b) => b < 0)) throw new Error('bval contains negative values.');
  if (frames !== undefined && bvals.length !== frames) throw new Error(`The image has ${frames} volumes but the bval file lists ${bvals.length}.`);
  return bvals;
}

/**
 * Parses and validates an FSL bval/bvec pair: non-empty, finite, non-negative b-values, three
 * bvec rows of the same length. Throws an Error a user can act on.
 * @returns {{ bvals: number[], bvecs: [number[], number[], number[]] }}
 */
export function parseBvalBvec(bvalText, bvecText) {
  const bvals = parseBval(bvalText);
  const rows = bvecText
    .trim()
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .map(parseNumbers);
  if (rows.length !== 3) throw new Error(`bvec must have 3 rows (x/y/z), found ${rows.length}.`);
  for (const row of rows) {
    if (row.length !== bvals.length) throw new Error(`bvec row has ${row.length} values but bval lists ${bvals.length} directions.`);
    if (!row.every(Number.isFinite)) throw new Error('bvec contains non-numeric or non-finite values.');
  }
  return { bvals, bvecs: [rows[0], rows[1], rows[2]] };
}

/** Validates a bval/bvec pair and returns its gradient-direction count. */
export function countDirections(bvalText, bvecText) {
  return parseBvalBvec(bvalText, bvecText).bvals.length;
}

/** The first b0 volume, as dtifit counts them (b < 50), or the first volume when none is. */
export function b0Index(bvalText) {
  return Math.max(0, parseNumbers(bvalText).findIndex(isB0));
}

/** Whether a volume with this b-value is a b0 (b < B0_THRESHOLD). */
export function isB0(b) {
  return b < B0_THRESHOLD;
}

/**
 * The b0 volumes of a series, or every volume of a series without b-values (`bvals` null).
 * Throws when a b-value is not finite and non-negative, or when no volume is a b0.
 * @returns {number[]}
 */
export function b0Volumes(bvals, frames) {
  if (!bvals) return Array.from({ length: frames }, (_, i) => i);
  if (!bvals.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('The bval file must contain finite non-negative b-values.');
  }
  const b0 = bvals.flatMap((b, i) => (isB0(b) ? [i] : []));
  if (!b0.length) throw new Error(`The bval file lists no b0 volume (b < ${B0_THRESHOLD} s/mm²).`);
  return b0;
}

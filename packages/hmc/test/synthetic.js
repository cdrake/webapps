// A small synthetic DWI series with known rigid motion: a 32^3, 2 mm int16 grid of three
// Gaussian blobs (the shape of packages/hmc-registration/scripts/make-test-data.mjs), six
// volumes, each sampled from the formula after its motion, so every motion is exact.
// The grid's world centre is not the origin, so the QSIPrep pivot convention matters.

export const SIZE = 32;
export const SPACING = 2;
/** The world (RAS) position of the grid centre. */
export const CENTRE = Object.freeze([4, -6, 2]);
export const ORIGIN = Object.freeze(CENTRE.map((c) => c - ((SIZE - 1) * SPACING) / 2));

const BLOBS = [
  { amplitude: 1000, centre: [-6, 4, 2], sigma: [10, 7, 8] },
  { amplitude: 600, centre: [10, -8, -6], sigma: [5, 5, 5] },
  { amplitude: 400, centre: [-2, -12, 10], sigma: [4, 4, 4] },
];

const DEG = Math.PI / 180;

/**
 * Each volume: its b-value, its b-vector, and its motion as a rotation about RAS z (radians,
 * about the grid centre) and a shift (RAS mm). b0 volumes do not move.
 */
export const VOLUMES = Object.freeze([
  { bval: 0, bvec: [0, 0, 0], angle: 0, shift: [0, 0, 0] },
  { bval: 1000, bvec: [1, 0, 0], angle: 0, shift: [3, -2, 4] },
  { bval: 1000, bvec: [0, 1, 0], angle: 0, shift: [-1.5, 2.5, 0.5] },
  { bval: 0, bvec: [0, 0, 0], angle: 0, shift: [0, 0, 0] },
  { bval: 1000, bvec: [1, 0, 0], angle: 4 * DEG, shift: [1, 0, -1] },
  { bval: 1000, bvec: [Math.SQRT1_2, Math.SQRT1_2, 0], angle: 0, shift: [0, 0, 0] },
]);

function intensity(x, y, z) {
  let sum = 0;
  for (const { amplitude, centre, sigma } of BLOBS) {
    const d = [x - centre[0] - CENTRE[0], y - centre[1] - CENTRE[1], z - centre[2] - CENTRE[2]].map((value, axis) => value / sigma[axis]);
    sum += amplitude * Math.exp(-0.5 * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]));
  }
  return Math.round(sum);
}

/** The voxels of the content moved by `angle` about z through CENTRE, then by `shift`. */
function volume({ angle, shift }) {
  const out = new Int16Array(SIZE ** 3);
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  let n = 0;
  for (let k = 0; k < SIZE; k++) {
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        // x = R (y - w) + w + shift, so y = R^T (x - w - shift) + w.
        const x = [i, j, k].map((index, axis) => ORIGIN[axis] + SPACING * index - CENTRE[axis] - shift[axis]);
        const y = [c * x[0] + s * x[1] + CENTRE[0], -s * x[0] + c * x[1] + CENTRE[1], x[2] + CENTRE[2]];
        out[n++] = intensity(...y);
      }
    }
  }
  return out;
}

/** The series as an int16 NIfTI-1 file, with its .bval and .bvec texts. */
export function makeSeries() {
  const frames = VOLUMES.length;
  const voxels = SIZE ** 3;
  const bytes = new Uint8Array(352 + voxels * frames * 2);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [4, SIZE, SIZE, SIZE, frames, 1, 1, 1].forEach((value, i) => view.setInt16(40 + 2 * i, value, true));
  view.setInt16(70, 4, true); // DT_INT16
  view.setInt16(72, 16, true);
  [1, SPACING, SPACING, SPACING, 3, 0, 0, 0].forEach((value, i) => view.setFloat32(76 + 4 * i, value, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  bytes[123] = 10; // millimetres and seconds
  view.setInt16(252, 1, true);
  view.setInt16(254, 1, true);
  ORIGIN.forEach((value, i) => view.setFloat32(268 + 4 * i, value, true));
  for (let row = 0; row < 3; row++) {
    view.setFloat32(280 + 16 * row + 4 * row, SPACING, true);
    view.setFloat32(280 + 16 * row + 12, ORIGIN[row], true);
  }
  bytes.set([0x6e, 0x2b, 0x31, 0], 344);
  VOLUMES.forEach((motion, v) => {
    new Int16Array(bytes.buffer, 352 + v * voxels * 2, voxels).set(volume(motion));
  });
  const bval = `${VOLUMES.map(({ bval }) => bval).join(" ")}\n`;
  const bvec = [0, 1, 2].map((axis) => VOLUMES.map(({ bvec }) => bvec[axis]).join(" ")).join("\n") + "\n";
  return { nifti: bytes, bval, bvec, bvals: VOLUMES.map(({ bval }) => bval), bvecs: [0, 1, 2].map((axis) => VOLUMES.map(({ bvec }) => bvec[axis])) };
}

/** The unmoved content, as Float32: the target of every diffusion-weighted volume. */
export function reference() {
  return Float32Array.from(volume({ angle: 0, shift: [0, 0, 0] }));
}

/** A sphere of radius 26 mm about CENTRE: the registration mask. */
export function sphereMask() {
  const out = new Uint8Array(SIZE ** 3);
  let n = 0;
  for (let k = 0; k < SIZE; k++) {
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const d = [i, j, k].map((index) => SPACING * (index - (SIZE - 1) / 2));
        out[n++] = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] <= 26 * 26 ? 1 : 0;
      }
    }
  }
  return out;
}

/**
 * QSIPrep's motion row of a volume: rotation vector (0, 0, angle) and the translation of the
 * pivot A[:3,:3]·c = CENTRE − ORIGIN, which is shift + (R − I)(pivot − CENTRE) = shift − (R − I)·ORIGIN.
 */
export function expectedMotion({ angle, shift }) {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const o = ORIGIN;
  const rMinusI = [
    [c - 1, -s, 0],
    [s, c - 1, 0],
    [0, 0, 0],
  ];
  const translation = shift.map((value, i) => value - (rMinusI[i][0] * o[0] + rMinusI[i][1] * o[1] + rMinusI[i][2] * o[2]));
  return { rotation: [0, 0, angle], translation };
}

/**
 * The registration argv of every test volume. It is not NiFreeze's (that argv belongs to the
 * estimator loop, #450): the images are the same content moved, so mean squares on every
 * voxel with small steps finds the motion to about 0.06 mm and 0.06 degrees here.
 */
export const ARGV = Object.freeze([
  "--dimensionality", "3", "--float", "1", "--random-seed", "1234",
  "--transform", "Rigid[0.05]",
  "--metric", "MeanSquares[fixed.nii,moving.nii,1,0,Regular,1]",
  "--convergence", "[500x250,1e-9,20]", "--shrink-factors", "2x1", "--smoothing-sigmas", "1x0vox",
  "--masks", "[mask.nii,NULL]",
  "--output", "[out]",
]);

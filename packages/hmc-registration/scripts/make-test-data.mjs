// Writes test/data/fixed.nii and test/data/moving.nii: a 32^3 int16 volume of three Gaussian
// blobs on a 2 mm grid, and the same blobs moved by SHIFT_RAS mm. Both are sampled from the
// formula, not resampled, so the shift is exact.
//
//   node packages/hmc-registration/scripts/make-test-data.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Where the moving image's content lies relative to the fixed image's, in RAS mm. */
export const SHIFT_RAS = Object.freeze([3, -2, 4]);

const SIZE = 32;
const SPACING = 2;
const ORIGIN = -((SIZE - 1) * SPACING) / 2;
const BLOBS = [
  { amplitude: 1000, centre: [-6, 4, 2], sigma: [10, 7, 8] },
  { amplitude: 600, centre: [10, -8, -6], sigma: [5, 5, 5] },
  { amplitude: 400, centre: [-2, -12, 10], sigma: [4, 4, 4] },
];

function intensity(x, y, z) {
  let sum = 0;
  for (const { amplitude, centre, sigma } of BLOBS) {
    const d = [x - centre[0], y - centre[1], z - centre[2]].map((value, axis) => value / sigma[axis]);
    sum += amplitude * Math.exp(-0.5 * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]));
  }
  return Math.round(sum);
}

function nifti(shift) {
  const bytes = new Uint8Array(352 + SIZE ** 3 * 2);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [3, SIZE, SIZE, SIZE, 1, 1, 1, 1].forEach((value, i) => view.setInt16(40 + 2 * i, value, true));
  view.setInt16(70, 4, true); // DT_INT16
  view.setInt16(72, 16, true);
  [1, SPACING, SPACING, SPACING, 1, 0, 0, 0].forEach((value, i) => view.setFloat32(76 + 4 * i, value, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  bytes[123] = 2; // millimetres
  view.setInt16(252, 1, true); // qform: scanner, identity rotation
  view.setInt16(254, 1, true); // sform: scanner
  [ORIGIN, ORIGIN, ORIGIN].forEach((value, i) => view.setFloat32(268 + 4 * i, value, true));
  for (let row = 0; row < 3; row++) {
    view.setFloat32(280 + 16 * row + 4 * row, SPACING, true);
    view.setFloat32(280 + 16 * row + 12, ORIGIN, true);
  }
  bytes.set([0x6e, 0x2b, 0x31, 0], 344); // "n+1"
  let offset = 352;
  for (let k = 0; k < SIZE; k++) {
    for (let j = 0; j < SIZE; j++) {
      for (let i = 0; i < SIZE; i++) {
        const point = [i, j, k].map((index, axis) => ORIGIN + SPACING * index - shift[axis]);
        view.setInt16(offset, intensity(...point), true);
        offset += 2;
      }
    }
  }
  return bytes;
}

/** The fixed and moving NIfTI-1 files, byte for byte as committed. */
export function makeTestPair() {
  return { fixed: nifti([0, 0, 0]), moving: nifti(SHIFT_RAS) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { fixed, moving } = makeTestPair();
  await writeFile(new URL("../test/data/fixed.nii", import.meta.url), fixed);
  await writeFile(new URL("../test/data/moving.nii", import.meta.url), moving);
}

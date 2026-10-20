import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isReversePair, loadSdc, phaseEncoding } from "../src/wasm.js";

const { pyhysco } = await loadSdc(readFileSync(new URL("../src/sdc.wasm", import.meta.url)));

/** Gaussian bumps along j, shifted by `shift` mm. */
function bumps(dims, shift) {
  const [nx, ny, nz] = dims;
  const out = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const centre = ny + 2 * Math.sin(x - 4) + z;
        const position = (y + 0.5) * 2 - shift;
        out[x + nx * (y + ny * z)] = 100 * Math.exp(-(((position - centre) / 6) ** 2)) + 5;
      }
    }
  }
  return out;
}

test("a constant shift between the images gives a constant field in Hz", () => {
  const dims = [8, 40, 4];
  const shift = 3;
  const trt = 0.05;
  const out = pyhysco(bumps(dims, shift), bumps(dims, -shift), dims, [2, 2, 2], { phaseEncodingDirection: "j", totalReadoutTime: trt });
  assert.ok(out.iterations >= 1);
  const middle = [];
  for (let z = 0; z < dims[2]; z++) {
    for (let x = 0; x < dims[0]; x++) middle.push(out.field[x + dims[0] * (20 + dims[1] * z)]);
  }
  middle.sort((a, b) => a - b);
  const expected = shift / 2 / trt;
  const median = middle[middle.length >> 1];
  assert.ok(Math.abs(median - expected) < 0.1 * expected, `median ${median} Hz, expected ${expected}`);
  const negative = pyhysco(bumps(dims, shift), bumps(dims, -shift), dims, [2, 2, 2], { phaseEncodingDirection: "j-", totalReadoutTime: trt });
  assert.ok(Math.abs(negative.field[20 * dims[0]] + out.field[20 * dims[0]]) < 1e-9, "the sign follows image 1's direction");
});

test("invalid input is refused", () => {
  const image = new Float64Array(27).fill(1);
  assert.throws(() => pyhysco(image, image, [3, 3, 3], [2, 2, 2], { phaseEncodingDirection: "k", totalReadoutTime: 0.05 }), /must be i, i-, j or j-/);
  assert.throws(() => pyhysco(image, image, [3, 3, 3], [2, 2, 2], { phaseEncodingDirection: "j", totalReadoutTime: 0 }), /TotalReadoutTime/);
  assert.throws(() => pyhysco(image.subarray(1), image, [3, 3, 3], [2, 2, 2], { phaseEncodingDirection: "j", totalReadoutTime: 0.05 }), /Expected 27 voxels/);
  assert.throws(() => pyhysco(image, image, [3, 3, 3], [0, 2, 2], { phaseEncodingDirection: "j", totalReadoutTime: 0.05 }), /refused/);
});

test("phase-encoding directions", () => {
  assert.deepEqual(phaseEncoding("j-"), { axis: 1, sign: -1 });
  assert.deepEqual(phaseEncoding("i"), { axis: 0, sign: 1 });
  assert.ok(isReversePair("j-", "j"));
  assert.ok(!isReversePair("j", "j"));
  assert.ok(!isReversePair("i", "j-"));
});

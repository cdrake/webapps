import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadDegibbs, sliceAxes } from "../src/wasm.js";

const { degibbs } = await loadDegibbs(readFileSync(new URL("../src/degibbs.wasm", import.meta.url)));

test("a constant volume is unchanged", () => {
  const dims = [16, 12, 3];
  const out = degibbs(new Float32Array(16 * 12 * 3 * 2).fill(5), dims, 2);
  for (const value of out) assert.ok(Math.abs(value - 5) < 1e-4, `${value}`);
});

test("every slice is corrected the same way, whatever its position", () => {
  const dims = [16, 12, 2];
  const slice = Float32Array.from({ length: 16 * 12 }, (_, i) => ((i % 16) > 5 && (i % 16) < 11 ? 100 : 0));
  const data = new Float32Array(slice.length * 2);
  data.set(slice, 0);
  data.set(slice, slice.length);
  const out = degibbs(data, dims, 1);
  assert.deepEqual(out.subarray(0, slice.length), out.subarray(slice.length));
});

test("invalid options and sizes are refused", () => {
  assert.throws(() => degibbs(new Float32Array(8), [2, 2, 2], 1, { axes: [0, 0] }), /different in-plane axes/);
  assert.throws(() => degibbs(new Float32Array(7), [2, 2, 2], 1), /Expected 8 voxels/);
});

test("SliceEncodingDirection selects the in-plane axes", () => {
  assert.deepEqual(sliceAxes(undefined), [0, 1]);
  assert.deepEqual(sliceAxes("k-"), [0, 1]);
  assert.deepEqual(sliceAxes("j"), [0, 2]);
  assert.deepEqual(sliceAxes("i"), [1, 2]);
  assert.throws(() => sliceAxes("x"), /Unknown/);
});

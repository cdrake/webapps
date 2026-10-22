// The JavaScript glue on the committed hmc.wasm.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMatTransform } from "@neurodesk/hmc-registration";
import { IDENTITY, loadHmc } from "../src/wasm.js";
import { loadHmcNode } from "../src/node.js";

const hmc = await loadHmcNode();
const SHIFT = { parameters: [1, 0, 0, 0, 1, 0, 0, 0, 1, -3, 2, 4], fixed: [0, 0, 0] };
const GRID = {
  shape: [8, 8, 8],
  affine: [
    [2, 0, 0, -7],
    [0, 2, 0, -7],
    [0, 0, 2, -7],
    [0, 0, 0, 1],
  ],
};

test("loads from bytes, a Response and a compiled module", async () => {
  const bytes = await readFile(new URL("../src/hmc.wasm", import.meta.url));
  for (const source of [bytes, new Response(bytes, { headers: { "content-type": "application/wasm" } }), await WebAssembly.compile(bytes)]) {
    const api = await loadHmc(source);
    assert.deepEqual(api.readMat(api.writeMat(SHIFT)).parameters, SHIFT.parameters);
  }
});

test("writeMat writes the file that ANTs and hmc-registration's reader read", () => {
  const bytes = hmc.writeMat(SHIFT);
  assert.deepEqual(readMatTransform(bytes), { transform: "AffineTransform_float_3_3", parameters: SHIFT.parameters, fixed: SHIFT.fixed });
  assert.equal(readMatTransform(hmc.writeMat(SHIFT, { precision: "double" })).transform, "AffineTransform_double_3_3");
  assert.deepEqual(hmc.readMat(bytes), { ...SHIFT, precision: "float" });
  assert.throws(() => hmc.readMat(bytes.subarray(0, 40)), /truncated/);
});

test("float files hold the values rounded to float", () => {
  const { parameters, fixed } = hmc.readMat(hmc.writeMat({ parameters: [0.9998, 0.01, 0, -0.01, 0.9998, 0, 0, 0, 1, 1.5, -2.25, 0.125], fixed: [1, 2, 3] }));
  assert.equal(parameters[0], Math.fround(0.9998));
  assert.deepEqual(fixed, [1, 2, 3]);
});

test("motion is RAS+: an LPS translation (-3, 2, 4) is (3, -2, 4)", () => {
  const [identity, shift] = hmc.motionParams([IDENTITY, SHIFT], GRID);
  // transforms3d's decompose44 gives a shear of -0 here; -0 + 0 is 0.
  const plain = (row) => Object.fromEntries(Object.entries(row).map(([key, values]) => [key, values.map((v) => v + 0)]));
  assert.deepEqual(plain(identity), { scale: [1, 1, 1], shear: [0, 0, 0], rotation: [0, 0, 0], translation: [0, 0, 0] });
  assert.deepEqual(shift.translation, [3, -2, 4]);
  const rigid = hmc.motionTsv([IDENTITY, SHIFT], GRID).split("\n");
  assert.equal(rigid[0], "trans_x\ttrans_y\ttrans_z\trot_x\trot_y\trot_z\tframewise_displacement");
  assert.equal(rigid[2], "3.0\t-2.0\t4.0\t0.0\t0.0\t0.0\t9.0");
  const affine = hmc.motionTsv([IDENTITY, SHIFT], GRID, { columns: "affine" }).split("\n");
  assert.equal(affine[0].split("\t").length, 10);
  assert.equal(affine[1], "0.0\t0.0\t0.0\t0.0\t0.0\t0.0\tn/a\t1.0\t1.0\t1.0");
});

test("b0 rules and b-vector rotation of each method", () => {
  const bvals = [0, 50, 80, 1000];
  const bvecs = [
    [0, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  // NiFreeze: b <= 50 is a b0; QSIPrep: b < 100.
  assert.deepEqual(hmc.b0Flags("nifreeze", bvals, bvecs), [true, true, false, false]);
  assert.deepEqual(hmc.b0Flags("shoreline", bvals, bvecs), [true, true, true, false]);
  const nifreeze = hmc.rotateGradients("nifreeze", bvals, bvecs, [IDENTITY, IDENTITY, IDENTITY, SHIFT], GRID.affine);
  assert.equal(nifreeze.bval, "0.00 50.00 80.00 1000.00\n");
  assert.equal(nifreeze.bvec.split("\n")[0], "0.000000 1.000000 1.000000 1.000000");
  const shoreline = hmc.rotateGradients("shoreline", bvals, bvecs, [IDENTITY, IDENTITY, IDENTITY, SHIFT], GRID.affine);
  assert.equal(shoreline.bval, "0 50 80 1000\n");
  assert.equal(shoreline.bvec.split("\n")[0], "0.00000000 1.00000000 1.00000000 1.00000000");
  assert.throws(() => hmc.rotateGradients("nifreeze", bvals, bvecs, [IDENTITY], GRID.affine), /1 transforms for 4 volumes/);
  assert.throws(() => hmc.b0Flags("fsl", bvals, bvecs), /Unknown head-motion method/);
});

test("advanced_clip writes float volumes in place and leaves integer volumes", () => {
  const dims = [5, 4, 3];
  const values = Array.from({ length: 60 }, (_, i) => ((i * 37) % 23) * 10);
  const float = Float64Array.from(values);
  const report = hmc.advancedClipInPlace(float, dims);
  assert.equal(report.input, "float");
  assert.equal(report.mutated, true);
  assert.ok(report.aMax > report.aMin);
  assert.ok(float.every((v) => v >= 0 && v <= 255 && Number.isInteger(v)));
  assert.deepEqual(Array.from(hmc.advancedClip(Int16Array.from(values), dims)), Array.from(float));

  // A second visit clips the clipped map again, as NiFreeze's trivial model does to bzero.
  const again = Float64Array.from(float);
  hmc.advancedClipInPlace(again, dims);
  assert.ok(again.every((v) => v >= 0 && v <= 255));

  const integer = Int16Array.from(values);
  const kept = hmc.advancedClipInPlace(integer, dims);
  assert.deepEqual({ input: kept.input, mutated: kept.mutated }, { input: "integer", mutated: false });
  assert.deepEqual(Array.from(integer), values);
  assert.throws(() => hmc.advancedClipInPlace(new Float32Array(60), dims), /invalid percentile thresholds/);
  assert.throws(() => hmc.advancedClip(new Float32Array(10), dims), /do not fill/);
  assert.throws(() => hmc.advancedClip(new BigInt64Array(60), dims), /does not take/);
});

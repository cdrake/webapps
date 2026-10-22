import test from "node:test";
import assert from "node:assert/strict";
import { voxelWeights, tissueFractions, invert4, multiply4, apply4 } from "../src/voxel.js";

const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const box = (size, center) => [[size[0], 0, 0, center[0]], [0, size[1], 0, center[1]], [0, 0, size[2], center[2]], [0, 0, 0, 1]];

test("an axis-aligned box covers whole and half voxels exactly", () => {
  const { weights, volumeMm3, nominalMm3 } = voxelWeights(box([4, 4, 4], [10, 10, 10]), { affine: identity, dims: [20, 20, 20] }, { samples: 4 });
  const at = (x, y, z) => weights[x + 20 * (y + 20 * z)];
  assert.equal(at(10, 10, 10), 1);
  assert.equal(at(8, 10, 10), 0.5);
  assert.equal(at(12, 10, 10), 0.5);
  assert.equal(at(8, 8, 8), 0.125);
  assert.equal(at(7, 10, 10), 0);
  assert.equal(volumeMm3, 64);
  assert.equal(nominalMm3, 64);
});

test("an oblique box keeps its volume on the grid", () => {
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  // 20 x 30 x 25 mm, rotated about z then tilted about x.
  const rz = [[c, -s, 0], [s, c, 0], [0, 0, 1]];
  const rx = [[1, 0, 0], [0, Math.cos(0.3), -Math.sin(0.3)], [0, Math.sin(0.3), Math.cos(0.3)]];
  const r = rx.map((row) => [0, 1, 2].map((j) => row.reduce((sum, v, k) => sum + v * rz[k][j], 0)));
  const sizes = [20, 30, 25];
  const affine = [0, 1, 2].map((i) => [...[0, 1, 2].map((j) => r[i][j] * sizes[j]), [30.3, 29.7, 30.1][i]]).concat([[0, 0, 0, 1]]);
  const { volumeMm3, nominalMm3 } = voxelWeights(affine, { affine: identity, dims: [64, 64, 64] });
  assert.ok(Math.abs(nominalMm3 - 15000) < 1e-6);
  assert.ok(Math.abs(volumeMm3 / nominalMm3 - 1) < 0.005, `${volumeMm3} vs ${nominalMm3}`);
});

test("fractions do not depend on how the image grid is oriented", () => {
  // Grey matter left of x = 10 mm, white matter right of it; CSF above z = 12 mm.
  const tissueAt = ([x, , z]) => (z > 12 ? "csf" : x < 10 ? "gm" : "wm");
  const voxel = box([4, 4, 6], [10, 10, 11]);
  const grids = [
    { affine: identity, dims: [24, 24, 24] },
    // PIR-like grid as Philips writes: i -> -y, j -> -z, k -> +x, offset.
    { affine: [[0, 0, 1, -2], [-1, 0, 0, 21], [0, -1, 0, 22], [0, 0, 0, 1]], dims: [24, 24, 24] },
    // 0.8 mm voxels with a shifted origin.
    { affine: [[0.8, 0, 0, 0.3], [0, 0.8, 0, -0.2], [0, 0, 0.8, 0.1], [0, 0, 0, 1]], dims: [30, 30, 30] },
  ];
  const results = grids.map((grid) => {
    const n = grid.dims[0] * grid.dims[1] * grid.dims[2];
    const maps = { gm: new Float32Array(n), wm: new Float32Array(n), csf: new Float32Array(n) };
    for (let z = 0; z < grid.dims[2]; z += 1) for (let y = 0; y < grid.dims[1]; y += 1) for (let x = 0; x < grid.dims[0]; x += 1) {
      maps[tissueAt(apply4(grid.affine, [x, y, z]))][x + grid.dims[0] * (y + grid.dims[1] * z)] = 1;
    }
    const { weights } = voxelWeights(voxel, grid, { samples: 6 });
    return tissueFractions(weights, maps);
  });
  // On the 1 mm grids the tissue changes at voxel centres x = 10 (GM is 8.5..9.5
  // plus half of voxel 8) and z = 13 (CSF is voxel 13 and half of 14): exactly
  // 1.5/6 CSF and 1.5/4 of the rest GM. The permuted grid samples the same points.
  for (const f of results.slice(0, 2)) {
    assert.ok(Math.abs(f.csf - 0.25) < 1e-6 && Math.abs(f.gm - 0.75 * 0.375) < 1e-6, JSON.stringify(f));
    assert.equal(f.coverage, 1);
  }
  // The 0.8 mm grid approaches the continuous answer, a third each.
  for (const t of ["gm", "wm", "csf"]) assert.ok(Math.abs(results[2][t] - 1 / 3) < 0.1, JSON.stringify(results[2]));
});

test("matrix helpers invert and compose", () => {
  const a = [[0, 0, 1, -98.3], [-1, 0, 0, 134.2], [0, -1, 0, 146.2], [0, 0, 0, 1]];
  const p = multiply4(invert4(a), a);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) assert.ok(Math.abs(p[r][c] - identity[r][c]) < 1e-12);
  assert.throws(() => invert4([[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]), /inverted/);
  assert.throws(() => tissueFractions(new Float32Array(3), { gm: [1, 1, 1], wm: [0, 0, 0], csf: [0, 0, 0] }), /outside/);
});

test("tissue the maps leave out counts as CSF unless excluded", () => {
  // Four voxels: GM, WM, ventricle CSF, and one no map labels (a sulcus).
  const weights = new Float32Array([1, 1, 1, 1]);
  const maps = { gm: [1, 0, 0, 0], wm: [0, 1, 0, 0], csf: [0, 0, 1, 0] };
  assert.deepEqual(tissueFractions(weights, maps), { gm: 0.25, wm: 0.25, csf: 0.5, coverage: 0.75 });
  assert.deepEqual(tissueFractions(weights, maps, { unlabelled: "exclude" }), { gm: 1 / 3, wm: 1 / 3, csf: 1 / 3, coverage: 0.75 });
});

const near = (actual, expected, label, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs ${expected}`);

test("a general 4x4 matrix inverts from both sides", () => {
  // Every entry non-zero, so each cofactor term counts.
  const a = [[2, 1, 0.5, 3], [0.3, -1.5, 0.7, -2], [1.1, 0.4, 2.5, 4], [0.2, -0.6, 0.9, 1.7]];
  const inverse = invert4(a);
  assert.equal(inverse.length, 4);
  for (const product of [multiply4(inverse, a), multiply4(a, inverse)]) {
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) near(product[r][c], identity[r][c], `[${r}][${c}]`);
  }
  assert.throws(() => invert4([[1, 2, 3, 4], [2, 4, 6, 8], [0, 1, 0, 0], [0, 0, 1, 1]]), { message: "The affine cannot be inverted." });
});

test("the nominal volume is the box's own, sheared or mirrored", () => {
  // det of the 3x3 part is -23.9375: a mirrored, sheared box of 23.9375 mm^3.
  const sheared = [[-2, -1, 0.5, 5], [0.5, 3, 1, 5], [1, 0.25, 4, 5], [0, 0, 0, 1]];
  near(voxelWeights(sheared, { affine: identity, dims: [12, 12, 12] }).nominalMm3, 23.9375, "nominal");
});

/** Weights by a direct count: each image voxel's sub-points mapped to the box's index space. */
function countedWeights(voxelAffine, { affine, dims }, samples) {
  const toBox = multiply4(invert4(voxelAffine), affine);
  const offsets = Array.from({ length: samples }, (_, s) => (s + 0.5) / samples - 0.5);
  const weights = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1) for (let y = 0; y < dims[1]; y += 1) for (let x = 0; x < dims[0]; x += 1) {
    let inside = 0;
    for (const dz of offsets) for (const dy of offsets) for (const dx of offsets) {
      if (apply4(toBox, [x + dx, y + dy, z + dz]).every((v) => Math.abs(v) <= 0.5)) inside += 1;
    }
    weights[x + dims[0] * (y + dims[1] * z)] = inside / samples ** 3;
  }
  return weights;
}

test("a rotated box on a rotated 2 mm grid weights every voxel by its share inside", () => {
  const rotation = (a, b) => {
    const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
    return [[ca, -sa * cb, sa * sb], [sa, ca * cb, -ca * sb], [0, sb, cb]];
  };
  const place = (r, scale, centre) => [0, 1, 2].map((i) => [...[0, 1, 2].map((j) => r[i][j] * scale[j]), centre[i]]).concat([[0, 0, 0, 1]]);
  const voxel = place(rotation(0.5, 0.3), [9, 11, 7], [15.3, 14.7, 16.1]);
  const grid = { affine: place(rotation(-0.2, 0.15), [2, 2, 2], [-3.1, 1.7, -2.3]), dims: [16, 16, 16] };
  const result = voxelWeights(voxel, grid, { samples: 4 });
  const counted = countedWeights(voxel, grid, 4);
  let differ = 0;
  for (let i = 0; i < counted.length; i += 1) differ += Math.abs(result.weights[i] - counted[i]) * 64;
  assert.ok(differ <= 2, `${differ} sub-points differ from a direct count`);
  assert.equal(result.count, counted.filter((w) => w > 0).length);
  near(result.volumeMm3, counted.reduce((a, b) => a + b, 0) * 8, "volume", 1e-6);
  near(result.nominalMm3, 9 * 11 * 7, "nominal", 1e-9);
  assert.ok(Math.abs(result.volumeMm3 / result.nominalMm3 - 1) < 0.05, `${result.volumeMm3}`);
});

test("a box hanging over the image's edges counts only the part inside", () => {
  const grid = { affine: identity, dims: [6, 6, 6] };
  for (const centre of [[0, 0, 0], [5, 5, 5], [0, 5, 2.5]]) {
    const result = voxelWeights(box([4, 4, 4], centre), grid, { samples: 2 });
    const counted = countedWeights(box([4, 4, 4], centre), grid, 2);
    assert.deepEqual(Array.from(result.weights), Array.from(counted), JSON.stringify(centre));
    assert.equal(result.count, counted.filter((w) => w > 0).length);
    near(result.volumeMm3, counted.reduce((a, b) => a + b, 0), "volume");
  }
});

test("fractions weight each map by the box and scale back overlapping maps", () => {
  const weights = new Float32Array([0, 1, 0.5, 0]);
  // Outside the box the maps can hold anything, even NaN.
  const maps = { gm: [Number.NaN, 0.6, 0.2, 9], wm: [Number.NaN, 0.3, 0.2, 9], csf: [Number.NaN, 0, 0.2, 9] };
  const f = tissueFractions(weights, maps);
  near(f.gm, 0.7 / 1.5, "gm");
  near(f.wm, 0.4 / 1.5, "wm");
  near(f.csf, 1 - 1.1 / 1.5, "csf");
  near(f.coverage, 1.2 / 1.5, "coverage");
  // Maps that add up to more than the box are scaled back to it.
  const over = tissueFractions(new Float32Array([1, 1]), { gm: [1, 0.5], wm: [0.5, 1], csf: [0.5, 0] });
  near(over.gm, 1.5 / 3.5, "gm");
  near(over.wm, 1.5 / 3.5, "wm");
  near(over.csf, 0.5 / 3.5, "csf");
  near(over.coverage, 3.5 / 2, "coverage");
  assert.throws(() => tissueFractions(new Float32Array([1, 0]), { gm: [0, 1], wm: [0, 1], csf: [0, 1] }), { message: "The segmentation finds no tissue inside the spectroscopy voxel." });
  assert.throws(() => tissueFractions(new Float32Array(2), { gm: [1, 1], wm: [0, 0], csf: [0, 0] }), { message: "The spectroscopy voxel lies outside the structural image." });
});

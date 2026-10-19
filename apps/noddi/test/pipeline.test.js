import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAPS,
  TENSOR_FITS,
  bidsStem,
  chunks,
  dtifitMaps,
  emptyMaps,
  gatherChunk,
  gradientText,
  isEveryVolume,
  mapName,
  maskIndices,
  maskName,
  meanVolumes,
  scatterChunk,
  selectVolumes,
  stackFrames,
} from "../src/pipeline.js";

test("names follow BIDS BEP016 dwimap", () => {
  const stem = bidsStem("sub-01_ses-1_dwi.nii.gz");
  assert.equal(stem, "sub-01_ses-1");
  assert.equal(mapName(stem, "noddi", "icvf"), "sub-01_ses-1_model-noddi_param-icvf_dwimap.nii.gz");
  assert.equal(maskName(stem), "sub-01_ses-1_desc-brain_mask.nii.gz");
  assert.equal(bidsStem("data.nii"), "data");
});

test("every map has a unique parameter label within its model", () => {
  for (const maps of Object.values(MAPS)) {
    assert.equal(new Set(maps.map((m) => m.param)).size, maps.length);
  }
});

test("the mean b0 averages the given volumes voxel by voxel", () => {
  // Two volumes of four voxels: background 0-2, tissue 100.
  const data = Float32Array.from([0, 2, 100, 100, 2, 0, 100, 102]);
  const mean = meanVolumes(data, 4, [0, 1]);
  assert.deepEqual(Array.from(mean), [1, 1, 100, 101]);
});

test("gather and scatter round-trip a chunk of masked voxels", () => {
  const voxels = 5;
  const volumes = 2;
  const data = Float32Array.from([10, 11, 12, 13, 14, 20, 21, 22, 23, 24]);
  const indices = maskIndices(Uint8Array.from([0, 1, 0, 1, 1]));
  const [first, second] = chunks(indices, 2);
  assert.deepEqual(Array.from(first), [1, 3]);
  assert.deepEqual(Array.from(gatherChunk(data, voxels, volumes, first)), [11, 13, 21, 23]);
  const maps = emptyMaps("noddi", voxels);
  scatterChunk(maps, { ICVF: Float32Array.from([0.5]), unknown: Float32Array.from([9]) }, second);
  assert.deepEqual(Array.from(maps.ICVF), [0, 0, 0, 0, 0.5]);
  assert.equal(maps.unknown, undefined);
});

test("the tensor-fit options agree in the page, the automation schema and the pipeline", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const select = html.match(/<select id="tensorFit">([\s\S]*?)<\/select>/)[1];
  const options = [...select.matchAll(/<option value="([^"]+)"( selected)?/g)];
  assert.deepEqual(options.map((m) => m[1]), [...TENSOR_FITS]);
  assert.deepEqual(options.filter((m) => m[2]).map((m) => m[1]), ["wls"]);
  const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
  const parameter = automation.operations.fit.parameters.tensorFit;
  assert.deepEqual(parameter.enum, [...TENSOR_FITS]);
  assert.equal(parameter.default, "wls");
});

test("volume selection keeps the given volumes in their order, with their gradients", () => {
  // Three volumes of two voxels.
  const data = Float32Array.from([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Array.from(selectVolumes(data, 2, [0, 2])), [1, 2, 5, 6]);
  assert.equal(isEveryVolume([0, 1, 2], 3), true);
  assert.equal(isEveryVolume([0, 2], 3), false);
  assert.equal(isEveryVolume([1, 0, 2], 3), false);
  const text = gradientText([0, 1000, 2000], [[0, 1, 0], [0, 0, 1], [0, 0, 0]], [0, 1]);
  assert.deepEqual(text, { bval: "0 1000\n", bvec: "0 1\n0 0\n0 0\n" });
  // Each bvec becomes a unit vector and each b0 (b < 50) a zero vector, as in the WebAssembly fit.
  const scaled = gradientText([5, 1000], [[0.1, 0.9 * 0.6], [0.2, 0], [0, -0.9 * 0.8]], [0, 1]);
  assert.equal(scaled.bval, "5 1000\n");
  const rows = scaled.bvec.trim().split("\n").map((row) => row.split(" ").map(Number));
  assert.deepEqual(rows.map((row) => row[0]), [0, 0, 0]);
  const unit = rows.map((row) => row[1]);
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-15 && unit[1] === 0 && Math.abs(unit[2] + 0.8) < 1e-15, scaled.bvec);
});

test("niimath dtifit outputs map to the tensor maps: AD is L1, RD the mean of L2 and L3", () => {
  // Voxel 2 has a negative eigenvalue: dtifit sets its FA and MD to zero and keeps L1 to L3.
  const voxels = 3;
  const maps = dtifitMaps({
    FA: Float32Array.from([0.5, 0, 0]),
    MD: Float32Array.from([1e-3, 0, 0]),
    L1: Float32Array.from([2e-3, 0, 1.7e-3]),
    L2: Float32Array.from([1e-3, 0, 0.3e-3]),
    L3: Float32Array.from([0, 0, -1e-3]),
    S0: Float32Array.from([900, 0, 900]),
    V1: Float32Array.from([-0.6, 0, 0.6, 0, 0, 0, -0.8, 0, -0.8]),
  }, voxels);
  assert.deepEqual(Object.keys(maps).sort(), Object.keys(emptyMaps("tensor", voxels)).sort());
  assert.deepEqual(Array.from(maps.AD), [Math.fround(2e-3), 0, 0]);
  assert.deepEqual(Array.from(maps.RD), [Math.fround(0.5e-3), 0, 0]);
  // The largest-magnitude component of each direction is positive, as in the WebAssembly fit.
  assert.deepEqual(Array.from(maps.V1x), [Math.fround(0.6), 0, Math.fround(-0.6)]);
  assert.deepEqual(Array.from(maps.V1y), [0, 0, 0]);
  assert.deepEqual(Array.from(maps.V1z), [Math.fround(0.8), 0, Math.fround(0.8)]);
  assert.deepEqual(Array.from(maps.S0), [900, 0, 900]);
  assert.throws(() => dtifitMaps({ ...maps, L1: maps.AD, L2: maps.RD, L3: maps.RD, V1: maps.V1x }, voxels), /no V1 map/);
});

test("direction frames stack x, y and z volumes", () => {
  const maps = { a: Float32Array.from([1, 2]), b: Float32Array.from([3, 4]), c: Float32Array.from([5, 6]) };
  assert.deepEqual(Array.from(stackFrames(maps, ["a", "b", "c"])), [1, 2, 3, 4, 5, 6]);
});

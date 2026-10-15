import { test } from "node:test";
import assert from "node:assert/strict";
import { readVolume, writeVolume } from "@neurodesk/synthsr";
import {
  MAX_INPUT_VOXELS,
  fromNetworkOrder,
  networkGrid,
  networkResolutionGrid,
  brainBox,
  checkLogits,
  gaussianWeights,
  labelLesions,
  lesionTable,
  normalizeInBrain,
  resample,
  anisotropicAxis,
  segmentFlair,
  targetShape,
  threshold,
  toNetworkOrder,
  toNetworkResolution,
  windowStarts,
  windows,
} from "../src/pipeline.js";

const close = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `index ${i}: ${actual[i]} vs ${expected[i]}`);
};

test("the network sees NIfTI axes as (x, z, y), as FLAMeS's transpose_forward [2, 0, 1] sets", () => {
  const volume = { dims: [4, 5, 6], affine: [[-0.9, 0, 0, 0], [0, 0.8, 0, 0], [0, 0, 3, 0], [0, 0, 0, 1]] };
  assert.deepEqual(networkGrid(volume), { shape: [4, 6, 5], spacing: [0.9, 3, 0.8] });
  const dims = [2, 3, 4];
  const data = Float32Array.from({ length: 24 }, (_, i) => i);
  const network = toNetworkOrder(data, dims);
  // Voxel (x=1, y=2, z=3) is NIfTI index 1 + 2*2 + 3*6 = 23 and network index (1*4 + 3)*3 + 2 = 23.
  assert.equal(network[23], 23);
  // Voxel (x=1, y=0, z=0) is NIfTI index 1 and network index (1*4 + 0)*3 + 0 = 12.
  assert.equal(network[12], 1);
  assert.deepEqual(fromNetworkOrder(network, dims), data);
});

test("sliding windows follow nnU-Net's half-patch step", () => {
  assert.deepEqual(windowStarts(160, 160), [0]);
  assert.deepEqual(windowStarts(90, 112), [0]);
  assert.deepEqual(windowStarts(200, 112), [0, 44, 88]);
  assert.deepEqual(windowStarts(129, 128), [0, 1]);
  assert.equal(windows([140, 190, 160]).length, 2 * 2 * 1);
});

test("resampling to 1 x 0.9 x 0.9 mm rounds each axis", () => {
  assert.deepEqual(targetShape([48, 240, 240], [3, 0.958, 0.958]), [144, 255, 255]);
});

// Expected values from nnunetv2 resample_data_or_seg_to_shape with FLAMeS's orders (3 for images, 1 for probabilities).
test("isotropic resampling is nnU-Net's clipped cubic spline", () => {
  close(resample(Float32Array.of(0, 1, 4, 2), [1, 1, 4], [1, 1, 6], [1, 1, 1], [1, 1, 0.6667], 3), [0, 0.14471, 1.544308, 3.790628, 3.274519, 1.788788]);
});

test("an axis over three times coarser is resampled per slice, then by nearest slice", () => {
  assert.equal(anisotropicAxis([4, 1, 1]), 0);
  assert.equal(anisotropicAxis([1.2, 1, 1]), null);
  const cube = Float32Array.from({ length: 8 }, (_, i) => i);
  close(resample(cube, [2, 2, 2], [2, 4, 4], [4, 1, 1], [4, 0.5, 0.5], 3).subarray(0, 4), [0, 0.021454, 0.590084, 0.902885]);
  const deeper = resample(cube, [2, 2, 2], [4, 2, 2], [4, 1, 1], [2, 1, 1], 1);
  close([deeper[0], deeper[4], deeper[8], deeper[12]], [0, 0, 4, 4]);
});

test("a 0.4 mm FLAIR over SynthSR's 128 Mi voxel cap is still read", () => {
  // The scan that failed: a 544 x 544 x 480 sagittal FLAIR. The header alone is enough here,
  // as the voxel count is checked before the data is read.
  const buffer = writeVolume({ data: new Uint8Array(8), dims: [2, 2, 2], affine: [[0.4, 0, 0, 0], [0, 0.4, 0, 0], [0, 0, 0.4, 0]] });
  const header = new DataView(buffer);
  for (const [axis, size] of [544, 544, 480].entries()) header.setInt16(42 + 2 * axis, size, true);
  assert.throws(() => readVolume(buffer), /Unsupported image dimensions/);
  assert.throws(() => readVolume(buffer, { maxVoxels: MAX_INPUT_VOXELS }), /truncated/);
});

test("axes finer than the network's spacing are coarsened to it; coarser ones are kept", () => {
  // NIfTI x runs along the network's 1 mm axis, y and z along its 0.9 mm axes.
  const affine = [[0.45, 0, 0, 10], [0, 0.45, 0, 20], [0, 0, 3, 30], [0, 0, 0, 1]];
  const grid = networkResolutionGrid({ dims: [20, 18, 6], affine });
  assert.deepEqual(grid.dims, [9, 9, 6]);
  const expected = [[1, 0, 0, 10 + 0.45 * (20 / 9 - 1) / 2], [0, 0.9, 0, 20 + 0.225], [0, 0, 3, 30], [0, 0, 0, 1]];
  for (let r = 0; r < 4; r++) close(grid.affine[r], expected[r], 1e-9);
  assert.equal(networkResolutionGrid({ dims: [20, 18, 6], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 2.3, 0], [0, 0, 0, 1]] }), null);
});

test("a fine FLAIR is resampled once, so segmentation's own resampling has nothing to do", () => {
  const dims = [24, 24, 24];
  const affine = [[0, 0, 0.45, -5], [-0.45, 0, 0, 5], [0, 0.45, 0, -5], [0, 0, 0, 1]];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  // A skull-stripped cube of brain: nonzero inside voxels 6..17.
  for (let z = 6; z < 18; z++) for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) data[x + 24 * (y + 24 * z)] = 100;
  const { volume, brainMask, resampledFrom } = toNetworkResolution({ data, dims, affine }, { skullStripped: true });
  assert.deepEqual(resampledFrom, dims);
  assert.deepEqual(volume.dims, [11, 12, 12]);
  const { shape, spacing } = networkGrid(volume);
  assert.deepEqual(targetShape(shape, spacing), shape);
  // Voxel (0, 0, 0) is centred on the mean of the input voxels it covers.
  const covered = (n, m) => (n / m - 1) / 2;
  close([0, 1, 2].map((r) => volume.affine[r][3]), [-5 + 0.45 * covered(24, 12), 5 - 0.45 * covered(24, 11), -5 + 0.45 * covered(24, 12)], 1e-9);
  // The brain is the same 5.4 mm cube, without ringing from the zero background.
  const voxels = brainMask.reduce((sum, v) => sum + v, 0);
  assert.ok(Math.abs(voxels * 0.9 * 0.9 * 1 - 5.4 ** 3) < 0.15 * 5.4 ** 3, `${voxels} voxels`);
  assert.equal(brainMask.length, volume.data.length);
  assert.ok(volume.data.every((v) => v >= 0 && v <= 100));
});

test("an image already at the network's resolution is passed through untouched", () => {
  const volume = { data: new Float32Array(8), dims: [2, 2, 2], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
  assert.equal(toNetworkResolution(volume).volume, volume);
});

test("the importance map peaks at the patch centre and falls to exp(-24) at the corner", () => {
  const weights = gaussianWeights([112, 128, 160]);
  const centre = (56 * 128 + 64) * 160 + 80;
  assert.equal(weights[centre], 1);
  assert.ok(Math.abs(weights[0] / Math.exp(-24) - 1) < 1e-4);
});

test("normalization is a z-score inside the brain and zero outside", () => {
  close(normalizeInBrain(Float32Array.of(2, 4, 6, 100), Uint8Array.of(1, 1, 1, 0)), [-1.224745, 0, 1.224745, 0]);
});

test("the brain box is the mask's bounding box", () => {
  const mask = new Uint8Array(4 * 4 * 4);
  mask[(1 * 4 + 2) * 4 + 3] = 1;
  mask[(2 * 4 + 1) * 4 + 1] = 1;
  assert.deepEqual(brainBox(mask, [4, 4, 4]), { lo: [1, 1, 1], hi: [3, 3, 4], shape: [2, 2, 3] });
});

test("lesions are 26-connected and the table reports volume in millilitres", () => {
  const dims = [5, 5, 5];
  const mask = new Uint8Array(125);
  mask[0] = 1;
  mask[1 + 5 + 25] = 1;
  mask[4 + 4 * 5 + 4 * 25] = 1;
  const { lesions } = labelLesions(mask, dims);
  assert.deepEqual(lesions.map((l) => l.voxels), [2, 1]);
  assert.deepEqual(lesions[0].centroid, [0.5, 0.5, 0.5]);
  const affine = [[2, 0, 0, -10], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const table = lesionTable(lesions, affine);
  assert.equal(table.totalMl, 0.024);
  assert.equal(table.tsv, "lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm\n1\t2\t0.0160\t-9.0\t1.0\t1.0\n2\t1\t0.0080\t-2.0\t8.0\t8.0\n");
});

test("segmentation maps patch logits back onto the input grid", async () => {
  const dims = [120, 130, 40];
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 2.25, 0], [0, 0, 0, 1]];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  const brainMask = new Uint8Array(data.length);
  const at = (x, y, z) => (z * dims[1] + y) * dims[0] + x;
  for (let z = 5; z < 35; z++) {
    for (let y = 20; y < 110; y++) {
      for (let x = 20; x < 100; x++) {
        brainMask[at(x, y, z)] = 1;
        data[at(x, y, z)] = 100;
      }
    }
  }
  for (let z = 18; z < 22; z++) {
    for (let y = 60; y < 70; y++) {
      for (let x = 50; x < 60; x++) data[at(x, y, z)] = 300;
    }
  }
  let patches = 0;
  // A stand-in network: lesion logit minus background logit is the normalized intensity minus 2.
  const runPatch = async (tile) => {
    patches++;
    const logits = new Float32Array(tile.length * 2);
    for (let i = 0; i < tile.length; i++) logits[tile.length + i] = tile[i] - 2;
    return logits;
  };
  const { probability, windows: count, resampledShape } = await segmentFlair({ volume: { dims, affine, data }, brainMask, runPatch });
  assert.deepEqual(resampledShape, [80, 75, 100]);
  assert.equal(count, 1);
  assert.equal(patches, 1);
  const mask = threshold(probability);
  assert.equal(mask[at(55, 65, 20)], 1);
  assert.equal(mask[at(30, 30, 10)], 0);
  assert.equal(mask[at(5, 5, 2)], 0);
  const { lesions } = labelLesions(mask, dims);
  assert.equal(lesions.length, 1);
  assert.ok(Math.abs(lesions[0].voxels - 400) <= 80, `lesion voxels ${lesions[0].voxels}`);
});

test("folds are averaged: two folds that disagree cancel to probability one half", async () => {
  const dims = [120, 130, 40];
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 2.25, 0], [0, 0, 0, 1]];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]).fill(1);
  const brainMask = new Uint8Array(data.length).fill(1);
  const calls = [];
  const runPatch = async (tile, fold) => {
    calls.push(fold);
    const logits = new Float32Array(tile.length * 2);
    logits.fill(fold === 0 ? 3 : -3, tile.length);
    return logits;
  };
  const progress = [];
  const { probability, windows: count } = await segmentFlair({ volume: { dims, affine, data }, brainMask, runPatch, folds: 2, onPatch: (n, total) => progress.push([n, total]) });
  assert.equal(count, 2);
  assert.deepEqual(calls, [0, 0, 1, 1]);
  assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  assert.ok(Math.abs(probability[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(probability[probability.length - 1] - 0.5) < 1e-6);
});

test("blank or non-finite network output is rejected so WebGPU can fall back to the CPU", async () => {
  assert.throws(() => checkLogits(new Float32Array(8)), /same score for every voxel/);
  assert.throws(() => checkLogits(Float32Array.of(1, Number.NaN, 2, 3)), /non-finite/);
  assert.doesNotThrow(() => checkLogits(Float32Array.of(8.9, 8.7, -8.9, -8.7)));
  const dims = [120, 130, 40];
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 2.25, 0], [0, 0, 0, 1]];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]).fill(1);
  const brainMask = new Uint8Array(data.length).fill(1);
  const runPatch = async (tile) => new Float32Array(tile.length * 2);
  await assert.rejects(segmentFlair({ volume: { dims, affine, data }, brainMask, runPatch }), /same score for every voxel/);
});

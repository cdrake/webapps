import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisition, reconstructCG } from './acquisition.js';
import { matrixToPoints, pointsToMatrix, transformPoint } from './geometry.js';

const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
const make = (overrides = {}) => createAcquisition({ transforms: identity, volumeShape: [5, 5, 5], sliceShape: [3, 3], resolution: 1, psf: new Float64Array([1]), psfShape: [1, 1, 1], ...overrides });
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

test('slice geometry uses translation before rotation and round trips network points', () => {
  const m = new Float64Array([0, -1, 0, 2, 1, 0, 0, 3, 0, 0, 1, 4]);
  assert.deepEqual(transformPoint(m, [1, 0, 0]), [-3, 3, 4]);
  const recovered = pointsToMatrix(matrixToPoints(m, 128, 128, 1));
  m.forEach((v, i) => close(v, recovered[i]));
  assert.throws(() => pointsToMatrix(new Float64Array(9)), /degenerate/);
});

test('linear acquisition reproduces an affine intensity field at fractional coordinates', () => {
  const m = identity.slice();
  m[3] = 0.25;
  m[7] = 0.125;
  m[11] = 0.5;
  const op = make({ transforms: m });
  const volume = Float64Array.from({ length: 125 }, (_, i) => i % 5 + 2 * (Math.floor(i / 5) % 5) + 3 * Math.floor(i / 25));
  const result = op.forward(volume);
  result.data.forEach((v, i) => close(v, (i % 3 + 1.25) + 2 * (Math.floor(i / 3) + 1.125) + 3 * 2.5));
});

test('unmasked interior acquisition and adjoint satisfy the inner-product identity', () => {
  const m = identity.slice();
  m[3] = 0.3;
  const op = make({ transforms: m, psf: new Float64Array([0.25, 0.5, 0.25]), psfShape: [1, 1, 3] });
  const volume = Float64Array.from({ length: 125 }, (_, i) => Math.sin(i));
  const slices = Float64Array.from({ length: 9 }, (_, i) => Math.cos(i));
  const a = op.forward(volume).data;
  const at = op.adjoint(slices).data;
  close(a.reduce((sum, v, i) => sum + v * slices[i], 0), at.reduce((sum, v, i) => sum + v * volume[i], 0));
});

test('CUDA adjoint support cutoff differs from forward normalization at the border', () => {
  const m = identity.slice();
  m[11] = -2;
  const op = make({ transforms: m, sliceShape: [1, 1], psfShape: [1, 1, 3], psf: new Float64Array([0.6, 0.2, 0.2]) });
  close(op.forward(new Float64Array(125).fill(7)).data[0], 7);
  assert.equal(op.adjoint(new Float64Array([7])).data.reduce((a, b) => a + b, 0), 0);
});

test('masked forward and adjoint retain their distinct CUDA normalization rules', () => {
  const mask = new Uint8Array(125).fill(1);
  mask[62] = 0;
  const m = identity.slice();
  m[3] = 0.5;
  const op = make({ transforms: m, sliceShape: [1, 1], volumeMask: mask });
  close(op.forward(new Float64Array(125).fill(8)).data[0], 8);
  close(op.adjoint(new Float64Array([8])).data[63], 4);
  close(op.adjoint(new Float64Array([8]), { equalize: true }).data[63], 8);
});

test('SRR conjugate gradient reconstructs measured voxels and handles exact initial solution', () => {
  const op = make();
  const slices = Float64Array.from({ length: 9 }, (_, i) => i + 1);
  const reconstructed = reconstructCG(op, slices, new Float64Array(125));
  assert.deepEqual(op.forward(reconstructed).data, slices);
  assert.deepEqual(reconstructCG(op, slices, reconstructed), reconstructed);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { axisAngleToMatrix, matrixToAxisAngle, compose, inverse, transformPoint, meanTransform, stackTransforms } from './geometry.js';
import { resample, makePSF, nccLoss } from './resampling.js';
import { prepareRegistration, propagateTransforms, registerStacks } from './index.js';
import { registerVolume } from './stack-registration.js';

const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) < tolerance, `${a} differs from ${b}`);
const identity = axisAngleToMatrix([0, 0, 0, 0, 0, 0]);

test('trans_first composition, inverse and axis-angle preserve physical points', () => {
  const a = axisAngleToMatrix([0.3, -0.5, 0.7, 10, -4, 7]);
  const b = axisAngleToMatrix([-0.8, 0.2, 0.4, -9, 3, 1]);
  const point = [4, 5, 6];
  const expected = transformPoint(a, transformPoint(b, point));
  transformPoint(compose(a, b), point).forEach((v, i) => close(v, expected[i]));
  transformPoint(inverse(a), transformPoint(a, point)).forEach((v, i) => close(v, point[i]));
  for (const pose of [[0, 0, 0, 1, 2, 3], [Math.PI, 0, 0, 4, 5, 6], [-0.6, 0.8, 1.2, -4, 9, 3]]) {
    const matrix = axisAngleToMatrix(pose);
    const reconstructed = axisAngleToMatrix(matrixToAxisAngle(matrix));
    matrix.forEach((v, i) => close(v, reconstructed[i]));
  }
});

test('centered resampling preserves affine fields and normalized physical PSF', () => {
  const data = Float64Array.from({ length: 125 }, (_, i) => i % 5 + 2 * (Math.floor(i / 5) % 5) + 3 * Math.floor(i / 25));
  const result = resample(data, [5, 5, 5], [1, 1, 1], [2, 2, 2]);
  assert.deepEqual(result.shape, [2, 2, 2]);
  result.data.forEach((v, i) => close(v, (i % 2 ? 3 : 1) + 2 * ((i >> 1) & 1 ? 3 : 1) + 3 * ((i >> 2) & 1 ? 3 : 1)));
  const psf = makePSF([1.25, 1.25, 3.75]);
  close(psf.psf.reduce((a, b) => a + b, 0), 1);
  assert.ok(psf.psfShape[2] > psf.psfShape[0]);
  close(nccLoss([1, 2, 3], [3, 2, 1]), -1, 1e-5);
});

function stack() {
  const shape = [12, 10, 9];
  const data = new Float32Array(shape.reduce((a, b) => a * b, 1));
  const mask = new Uint8Array(data.length);
  for (let z = 2; z <= 6; z++) for (let y = 2; y <= 7; y++) for (let x = 3; x <= 8; x++) {
    const i = x + shape[0] * (y + shape[1] * z);
    data[i] = 1 + x / 10 + y / 20 + z / 30;
    mask[i] = 1;
  }
  return { shape, data, mask, resolution: [1, 1, 2], thickness: 3, transforms: stackTransforms(shape[2], 2) };
}

test('SVoRT preprocessing crops contiguous slice range and propagates excluded slice poses', () => {
  const prepared = prepareRegistration([stack()]);
  const record = prepared.records[0];
  assert.deepEqual([record.first, record.last], [2, 6]);
  assert.deepEqual(record.cropped.shape, [128, 128, 5]);
  close(meanTransform(record.cropped.transforms)[11], 0);
  const correction = axisAngleToMatrix([0.1, -0.2, 0.3, 4, 5, 6]);
  const transforms = Float64Array.from(Array.from({ length: 5 }, (_, i) => Array.from(compose(correction, record.cropped.transforms.subarray(i * 12, (i + 1) * 12)))).flat());
  const propagated = propagateTransforms([{ ...record.cropped, transforms }], prepared.records);
  for (let z = 0; z < 9; z++) {
    const expected = compose(correction, record.reset.transforms.subarray(z * 12, (z + 1) * 12));
    expected.forEach((v, i) => close(v, propagated.slices[0].transforms[z * 12 + i], 1e-7));
  }
});

test('multilevel finite-difference registration corrects a translated asymmetric volume', async () => {
  const shape = [16, 16, 16];
  const data = Float64Array.from({ length: 4096 }, (_, i) => {
    const x = i % 16;
    const y = Math.floor(i / 16) % 16;
    const z = Math.floor(i / 256);
    return Math.exp(-((x - 7) ** 2 / 8 + (y - 6) ** 2 / 12 + (z - 8) ** 2 / 6)) + 0.5 * Math.exp(-((x - 11) ** 2 + (y - 10) ** 2 + (z - 6) ** 2) / 3);
  });
  const target = { data, shape, resolution: [1, 1, 1], transform: identity };
  const source = { ...target, transform: axisAngleToMatrix([0, 0, 0, 2, -1, 0]) };
  const result = await registerVolume(source, target);
  // Captured from export_registration.py against pinned upstream on PyTorch CPU.
  close(result.loss, -0.9890349507331848, 1e-5);
  const expected = [0.9999783635, 0.0063677044, -0.0016551743, 0.0158086773, -0.0063664843, 0.9999794364, 0.0007407557, 0.0225383434, 0.0016598614, -0.0007301923, 0.9999983311, 0.0392399691];
  result.transform.forEach((v, i) => close(v, expected[i], 2e-4));
  assert.ok(Math.hypot(result.transform[3], result.transform[7], result.transform[11]) < 0.3);
});

test('stack-only registration executes without learned models and respects cancellation', async () => {
  const result = await registerStacks([stack()], { mode: 'stack' });
  assert.equal(result.registration.selected, 'stack');
  assert.equal(result.stacks[0].transforms.length, 9 * 12);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registerStacks([stack()], { mode: 'stack', signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(registerStacks([stack()]), /verified SVoRTv2/);
});

test('robust rotation mean matches the upstream ten-iteration stopping convention', () => {
  const rotations = [[.1,.2,.3],[.2,-.3,.1],[.8,.3,.2],[-.4,.1,.1],[.1,-.5,.6],[.3,.2,-.7]];
  const transforms = Float64Array.from(rotations.flatMap(rotation => Array.from(axisAngleToMatrix([...rotation,0,0,0]))));
  const result = matrixToAxisAngle(meanTransform(transforms, { robust: true }));
  const expected = [.15238862439178263,-.015369154045645827,.16243618347553285];
  expected.forEach((value, axis) => assert.ok(Math.abs(value - result[axis]) < 1e-10));
});

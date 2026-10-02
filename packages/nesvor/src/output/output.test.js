import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildSupportMask, supportHistogram, supportGaussianKernel, resampleSupportMask, volumeSampler, sampleWorldPoints, sampleMaskedVolume } from './index.js';

const fixture = JSON.parse(await readFile(new URL('./upstream-fixture.json', import.meta.url)));
const indices = (mask) => Array.from(mask.entries()).filter(([, value]) => value).map(([index]) => index);
const close = (actual, expected, tolerance) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${i}: ${value} vs ${expected[i]}`));
};

let support;
test('integrated Gaussian and learned-world support match pinned PointDataset.mask', async () => {
  assert.equal(fixture.sourceCommit, '730ddaa3711a2304386de34193ea4b957892fe7b');
  close(supportGaussianKernel(3), fixture.kernel, 0);
  assert.ok(supportGaussianKernel(3).reduce((a, b) => a + b, 0) < 1);
  support = await buildSupportMask(fixture.points, fixture.resolutions);
  assert.deepEqual(support.dims, fixture.support.dims);
  assert.deepEqual(support.affine, fixture.support.affine);
  assert.deepEqual(indices(support.mask), fixture.support.indices);
  assert.equal(support.mask.reduce((a, b) => a + b), 81);
});

test('isotropic output resampling matches upstream support and trilinear values', async () => {
  const resampled = await resampleSupportMask(support, 0.8);
  assert.deepEqual(resampled.dims, fixture.resampled.dims);
  close(resampled.affine.flat(), fixture.resampled.affine.flat(), 2e-6);
  assert.deepEqual(indices(resampled.mask), fixture.resampled.indices);
  close(fixture.resampled.indices.map((index) => resampled.data[index]), fixture.resampled.values, 3e-6);
});

test('requested output rotation preserves world placement and rebuilds the center', async () => {
  const rotated = await resampleSupportMask(support, 1, { rotation: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] });
  assert.deepEqual(rotated.dims, fixture.rotated.dims);
  close(rotated.affine.flat(), fixture.rotated.affine.flat(), 2e-6);
  assert.deepEqual(indices(rotated.mask), fixture.rotated.indices);
  close(fixture.rotated.indices.map((index) => rotated.data[index]), fixture.rotated.values, 3e-6);
});

test('histogram rounds ties to even and duplicate sampling scales its occupancy threshold', async () => {
  const grid = supportHistogram([0, 0, 0, 0.5, 0, 0, 1.5, 0, 0], [1, 1, 1]);
  assert.equal(grid.occupied, 2);
  assert.equal(Math.max(...grid.histogram), 2);
  const twice = await buildSupportMask([...fixture.points, ...fixture.points], fixture.resolutions);
  assert.deepEqual(twice.mask, support.mask);
  assert.equal(twice.threshold, Math.fround(support.threshold * 2));
});

const polynomial = async (points) => {
  const values = new Float32Array(points.length / 3);
  for (let i = 0; i < values.length; i++) {
    const x = Math.fround(points[3 * i] ** 2);
    const y = Math.fround(2 * Math.fround(points[3 * i + 1] ** 2));
    const z = Math.fround(3 * Math.fround(points[3 * i + 2] ** 2));
    values[i] = Math.fround(x + y) + z;
  }
  return values;
};

test('output PSF samples and averages match upstream sample_points with recorded normal draws', async () => {
  let cursor = 0;
  const sampled = await sampleWorldPoints(fixture.sampling.xyz, polynomial, { psfResolution: 0.8, nSamples: 4, batchSize: 2, normal: () => fixture.sampling.normals[cursor++] });
  assert.equal(cursor, fixture.sampling.normals.length);
  close(sampled, fixture.sampling.values, 2e-5);
});

test('one sample or disabled PSF never introduces jitter; mask exterior remains zero', async () => {
  for (const options of [{ psfResolution: 0.8, nSamples: 1 }, { psfResolution: 0, nSamples: 128 }, { psfResolution: -1, nSamples: 128 }]) {
    const output = await sampleMaskedVolume(support, polynomial, { ...options, normal: () => { throw new Error('unexpected jitter'); } });
    assert.equal(output.data.filter((value) => value !== 0).length, 81);
    assert.deepEqual(output.mask, support.mask);
    assert.ok(output.data.every((v, i) => support.mask[i] || v === 0));
  }
  assert.equal(volumeSampler(support)([-10000, 0, 0]), 0);
});

test('memory budget, empty support and cancellation reject explicitly', async () => {
  assert.throws(() => supportHistogram(fixture.points, fixture.resolutions, { maxVoxels: 20 }), /limit/);
  await assert.rejects(resampleSupportMask({ ...support, mask: new Uint8Array(support.mask.length) }, 1), /empty/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(buildSupportMask(fixture.points, fixture.resolutions, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(sampleMaskedVolume(support, polynomial, { signal: controller.signal }), { name: 'AbortError' });
});

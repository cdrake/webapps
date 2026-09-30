import test from 'node:test';
import assert from 'node:assert/strict';
import { writeVolume, readVolume } from '../../synthsr/src/volume.js';
import { prepareReference, reconstructReference } from './reference-workflow.js';
import { validateBrowserReference } from './browser.js';
import { Tape, transform } from './training/index.js';

function request(affine = [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 2, 30], [0, 0, 0, 1]]) {
  const dims = [3, 3, 3];
  return {
    stacks: [{
      image: writeVolume({ dims, affine, data: Float32Array.from({ length: 27 }, (_, i) => 1 + i / 27) }),
      mask: writeVolume({ dims, affine, data: new Uint8Array(27).fill(1) }),
      thickness: 2,
    }],
    options: { registration: 'none', outputResolution: 2 },
    reference: { acknowledged: true },
  };
}

test('reference refuses an unacknowledged reduced preset, missing masks and unsupported registration', () => {
  const r = request();
  assert.throws(() => validateBrowserReference({ ...r, reference: {} }), /Acknowledge/);
  assert.throws(() => validateBrowserReference({ ...r, options: { ...r.options, registration: 'svort' } }), /SVoRT/);
  assert.throws(() => validateBrowserReference({ ...r, stacks: [{ ...r.stacks[0], mask: undefined }] }), /reviewed/);
  assert.throws(() => validateBrowserReference({ ...r, options: { ...r.options, biasFieldCorrection: true } }), /biasFieldCorrection/);
});

test('scanner coordinates survive rotation, reflection and anisotropic voxel spacing', () => {
  const matrices = [
    [[0, -2, 0, 10], [1, 0, 0, 20], [0, 0, 3, 30], [0, 0, 0, 1]],
    [[-1, 0, 0, 10], [0, 2, 0, 20], [0, 0, 3, 30], [0, 0, 0, 1]],
    [[-1, 0, 0, 10], [0, -2, 0, 20], [0, 0, 3, 30], [0, 0, 0, 1]],
  ];
  for (const affine of matrices) {
    const prepared = prepareReference(request(affine));
    prepared.observations.forEach((observation, index) => {
      const voxel = [index % 3, Math.floor(index / 3) % 3, Math.floor(index / 9)];
      const expected = affine.slice(0, 3).map((row) => row.slice(0, 3).reduce((sum, value, i) => sum + value * voxel[i], row[3]));
      const tape = new Tape();
      const pose = prepared.poses.slice(observation.slice * 6, observation.slice * 6 + 6).map((v) => tape.constant(v));
      const actual = transform(tape, pose, observation.xyz.map((v) => tape.constant(v))).map((v, axis) => v.value * 30 + prepared.center[axis]);
      actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-5));
    });
  }
});

test('upstream centering removes scanner origin from the optimized translations', () => {
  const first = prepareReference(request());
  const shifted = prepareReference(request([[1, 0, 0, 1010], [0, 1, 0, -1980], [0, 0, 2, 3030], [0, 0, 0, 1]]));
  first.poses.forEach((value, i) => assert.ok(Math.abs(value - shifted.poses[i]) < 1e-12));
  assert.deepEqual(first.boundingBox, shifted.boundingBox);
  assert.deepEqual(first.observations, shifted.observations);
});

test('reference rejects mismatched mask geometry and sheared input', () => {
  const r = request();
  r.stacks[0].mask = request([[1, 0, 0, 11], [0, 1, 0, 20], [0, 0, 2, 30], [0, 0, 0, 1]]).stacks[0].mask;
  assert.throws(() => prepareReference(r), /same dimensions and affine/);
  assert.throws(() => prepareReference(request([[1, 0.3, 0, 10], [0, 1, 0, 20], [0, 0, 2, 30], [0, 0, 0, 1]])), /Sheared/);
});

test('CPU reference performs per-case fitting and emits a finite spatially located NIfTI', async () => {
  const r = request();
  const stages = new Set();
  const fractions = [];
  const result = await reconstructReference(r, { onProgress: ({ stage, fraction }) => {
    stages.add(stage);
    fractions.push(fraction);
  } });
  const volume = readVolume(result.volume);
  assert.deepEqual(volume.dims, [2, 2, 3]);
  assert.deepEqual(volume.affine, [[2, 0, 0, 10], [0, 2, 0, 20], [0, 0, 2, 30], [0, 0, 0, 1]]);
  assert.ok(volume.data.every((v) => Number.isFinite(v) && v > 0));
  assert.deepEqual([...stages], ['preparing', 'training', 'sampling']);
  assert.equal(result.provenance.validated, false);
  assert.equal(result.provenance.preset.iterations, 100);
  assert.equal(fractions[0], 0);
  assert.equal(fractions.at(-1), 1);
  assert.ok(fractions.every((value, i) => Number.isFinite(value) && value >= (fractions[i - 1] ?? 0) && value <= 1));
});

test('cancellation stops fitting without publishing output', async () => {
  const controller = new AbortController();
  await assert.rejects(reconstructReference(request(), { signal: controller.signal, onProgress: ({ stage }) => {
    if (stage === 'training') controller.abort();
  } }), { name: 'AbortError' });
});

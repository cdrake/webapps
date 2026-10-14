import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareInput, segmentPrepared } from '../src/segment.js';
import { getTask, runSettings } from '../src/tasks.js';
import { niftiBytes, niftiVoxels } from './nifti-fixture.js';

const DIMS = [8, 8, 8];
const index = (x, y, z) => x + y * DIMS[0] + z * DIMS[0] * DIMS[1];

// A cord (value 1) with a lesion core (value 3) in the image's own voxel order.
function phantom() {
  const values = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]);
  for (let z = 1; z < 7; z++) {
    for (let y = 3; y < 6; y++) {
      for (let x = 1; x < 4; x++) values[index(x, y, z)] = 1;
    }
  }
  values[index(2, 4, 3)] = 3;
  values[index(2, 4, 4)] = 3;
  return values;
}

const ort = {
  Tensor: class {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
    }

    dispose() {}
  },
};

// Stands in for SCIsegV2: channel 0 (cord) is every above-mean voxel, channel 1
// (lesion) the brightest ones, as channel-major logits.
function fakeRegionSession() {
  const session = {
    inputNames: ['input'],
    outputNames: ['output'],
    released: false,
    async run({ input }) {
      const patch = input.data;
      const max = Math.max(...patch);
      const logits = new Float32Array(patch.length * 2);
      patch.forEach((value, voxel) => {
        logits[voxel] = value > 0 ? 10 : -10;
        logits[patch.length + voxel] = value >= max - 1e-6 ? 10 : -10;
      });
      return { output: { data: logits } };
    },
    async release() {
      session.released = true;
    },
  };
  return session;
}

test('a region task writes cord, lesion and metrics in the input voxel order', async () => {
  const values = phantom();
  // x runs right to left, so the image is not RAS and must be returned to its own order.
  const input = niftiBytes(DIMS, values, { srow: [[-1, 0, 0, 7], [0, 1, 0, 0], [0, 0, 1, 0]] });
  const analysis = [];
  const prepared = prepareInput(input, { events: { analysis: (message) => analysis.push(message) } });
  assert.equal(prepared.isIdentity, false);

  const task = getTask('lesion_sci_t2');
  const settings = { ...runSettings(task), patchSize: DIMS, preprocessing: {} };
  const session = fakeRegionSession();
  const streamed = [];
  const states = [];
  const { results, segmentationState } = await segmentPrepared(prepared, settings, {
    ort,
    session,
    events: { analysis: (message) => analysis.push(message), stage: (result) => streamed.push(result.stage), segmentationState: (state) => states.push(state) },
  });

  assert.deepEqual(results.map(({ stage }) => stage), ['segmentation', 'lesion', 'lesion_metrics']);
  assert.deepEqual(streamed, ['segmentation', 'lesion', 'lesion_metrics']);
  assert.ok(results.every(({ taskId }) => taskId === 'lesion_sci_t2'));
  assert.equal(session.released, true, 'the session is released after inference');
  assert.equal(states.length, 1);
  assert.equal(states[0], segmentationState);

  const cord = niftiVoxels(results[0].niftiData);
  const lesion = niftiVoxels(results[1].niftiData);
  assert.deepEqual(cord.dims, DIMS);
  assert.equal(cord.datatype, 2, 'uint8 labels');
  assert.deepEqual([...cord.voxels], [...values].map(value => (value > 0 ? 1 : 0)));
  assert.deepEqual([...lesion.voxels], [...values].map(value => (value === 3 ? 1 : 0)));

  const metrics = results[2];
  assert.equal(metrics.kind, 'metrics');
  assert.equal(metrics.filename, 'lesion_sci_t2_lesion_metrics.csv');
  assert.equal(metrics.summary.lesion_count, 1);
  assert.equal(metrics.summary.total_volume_mm3, 2);
  assert.match(metrics.csv, /dorsal_bridge_width_mm/);
  assert.ok(analysis.includes('Input volume: 8x8x8, spacing: 1.000x1.000x1.000mm'));
  assert.ok(analysis.includes('segmentation: 54 voxels (54.0 mm^3)'));
});

test('an unreadable input is refused before any inference', () => {
  assert.throws(() => prepareInput(new ArrayBuffer(16)));
});

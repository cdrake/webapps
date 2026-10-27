import assert from 'node:assert/strict';
import test from 'node:test';
import { createNiftiFromVolume, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { runInference } from '../src/pipeline.js';

const input = createNiftiFromVolume({ img: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8), hdr: {
  dims: [2, 2, 2], pixDims: [1, 1, 1], affine: [[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]],
} });

test('v1: three-class softmax and two-model probability averaging retain the input geometry', async () => {
  const released = [];
  const disposed = [];
  const correction = [];
  const result = await runInference(input, {
    model: 'v1', selectedModels: [42, 123], threshold: 0.6, nMarkers: 3,
    qsm: { makehomogeneous_wasm: (...args) => { correction.push(args.slice(1)); return args[0]; } },
    loadModel: async asset => asset.seed,
    Tensor: class { constructor(_type, _data, dims) { assert.deepEqual(dims, [1, 1, 32, 32, 32]); } dispose() { disposed.push(true); } },
    createSession: async seed => ({ inputNames: ['input'], outputNames: ['output'],
      run: async () => {
        const raw = new Float32Array(3 * 32 ** 3);
        raw.fill(Math.log(seed === 42 ? 2 : 6), 32 ** 3, 2 * 32 ** 3);
        return { output: { data: raw } };
      }, release: async () => released.push(seed),
    }),
  });
  assert.deepEqual(correction, [[2, 2, 2, 1, 1, 1, 7, 15]]);
  assert.deepEqual(released, [42, 123]);
  assert.equal(disposed.length, 2);
  for (const [stage, expected] of [['model1', 0.5], ['model2', 0.75], ['avgProb', 0.625], ['consensus', 1]]) {
    const volume = await readNifti(result.stages[stage].niftiData);
    assert.deepEqual(volume.dims, [2, 2, 2]);
    assert.deepEqual(volume.header.affine.map(row => Array.from(row)), [[1, 0, 0, 4], [0, 1, 0, 5], [0, 0, 1, 6], [0, 0, 0, 1]]);
    assert.ok(volume.data.every(value => value === expected), stage);
  }
  assert.equal(result.markerVoxels, 8);
});

test('v1: failed inference releases the real-session adapter resources and emits no result', async () => {
  let released = false;
  let disposed = false;
  let stages = 0;
  await assert.rejects(runInference(input, { model: 'v1', selectedModels: [42],
    qsm: { makehomogeneous_wasm: data => data }, loadModel: async () => 42,
    Tensor: class { dispose() { disposed = true; } },
    createSession: async () => ({ inputNames: ['input'], outputNames: ['output'],
      run: async () => { throw new Error('runtime failed'); }, release: async () => { released = true; } }),
    events: { stageData: () => stages++ },
  }), /runtime failed/);
  assert.ok(released && disposed);
  assert.equal(stages, 0);
});

test('v1 defaults run all four published checkpoints and produce their consensus', async () => {
  const { runInference: runPublicInference } = await import('@neurodesk/seedseg');
  const loaded = [];
  const ran = [];
  const released = [];
  const result = await runPublicInference(input, {
    model: 'v1',
    qsm: { makehomogeneous_wasm: data => data },
    loadModel: async asset => {
      loaded.push(asset.seed);
      return asset.seed;
    },
    Tensor: class { dispose() {} },
    createSession: async seed => ({
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => {
        ran.push(seed);
        // Zero logits give equal three-class probabilities independently of the checkpoint.
        return { output: { data: new Float32Array(3 * 32 ** 3) } };
      },
      release: async () => released.push(seed),
    }),
  });
  assert.deepEqual(loaded, [42, 123, 456, 789]);
  assert.deepEqual(ran, [42, 123, 456, 789]);
  assert.deepEqual(released, [42, 123, 456, 789]);
  assert.deepEqual(Object.keys(result.stages), ['model1', 'model2', 'model3', 'model4', 'avgProb', 'consensus']);
  const average = await readNifti(result.stages.avgProb.niftiData);
  assert.ok(average.data.every(value => value === Math.fround(1 / 3)));
  const consensus = await readNifti(result.stages.consensus.niftiData);
  assert.ok(consensus.data.every(value => value === 1));
  assert.equal(result.markerVoxels, 8);
});

// A fake network over the v2 patch: logit 0 for every class except the marker class inside `marked`.
function fakeNetwork(name, marked, calls) {
  const [pz, py, px] = [32, 256, 224];
  return {
    run: async ({ input }) => {
      calls.push(['run', name]);
      const logits = new Float32Array(3 * pz * py * px);
      for (const index of marked(input.data)) logits[pz * py * px + index] = 10;
      return { logits: { data: logits, dispose() {} } };
    },
    release: async () => calls.push(['release', name]),
  };
}

const v2Input = createNiftiFromVolume({ img: Float32Array.from({ length: 8 * 8 * 4 }, (_, i) => 1 + (i % 7)), hdr: {
  dims: [8, 8, 4], pixDims: [0.6875, 0.6875, 2], affine: [[0.6875, 0, 0, 10], [0, 0.6875, 0, 20], [0, 0, 2, 30], [0, 0, 0, 1]],
} });

test('v2: networks run one session at a time, average and rank markers on the input grid', async () => {
  const calls = [];
  const detections = [];
  // The 8 x 8 x 4 input sits centred in the 32 x 256 x 224 patch (offsets 14, 124, 108).
  const patchIndex = (x, y, z) => ((z + 14) * 256 + y + 124) * 224 + x + 108;
  const result = await runInference(v2Input, {
    folds: [3, 0], threshold: 0.5, nMarkers: 3,
    qsm: { makehomogeneous_wasm: data => data },
    loadModel: async asset => {
      calls.push(['load', asset.fold]);
      return asset.fold;
    },
    Tensor: class { constructor(type, data, dims) { assert.deepEqual(dims, [1, 1, 32, 256, 224]); this.data = data; } dispose() {} },
    createSession: async (fold, backend) => {
      calls.push(['create', fold, backend]);
      // Fold 0 marks two voxels, fold 3 one of them, so their mean probabilities differ.
      return fakeNetwork(fold, () => (fold === 0 ? [patchIndex(1, 1, 1), patchIndex(6, 6, 2)] : [patchIndex(6, 6, 2)]), calls);
    },
    events: { detections: value => detections.push(value) },
  });
  assert.deepEqual(calls, [['load', 0], ['create', 0, 'wasm'], ['run', 0], ['release', 0],
    ['load', 3], ['create', 3, 'wasm'], ['run', 3], ['release', 3]]);
  assert.deepEqual(Object.keys(result.stages), ['probability', 'markers']);
  const markers = await readNifti(result.stages.markers.niftiData);
  assert.deepEqual(markers.dims, [8, 8, 4]);
  assert.equal(markers.data[(2 * 8 + 6) * 8 + 6], 1);
  assert.equal(markers.data[(1 * 8 + 1) * 8 + 1], 2);
  assert.equal(result.markerVoxels, 2);
  const [summary] = detections;
  assert.equal(summary.countFlag, true);
  assert.deepEqual(summary.folds, [0, 3]);
  assert.equal(summary.backend, 'wasm');
  assert.deepEqual(summary.markers[0].centroidVox, [6, 6, 2]);
  assert.deepEqual(summary.markers[0].centroidWorldMm, [10 + 6 * 0.6875, 20 + 6 * 0.6875, 34]);
  assert.ok(summary.markers[0].meanProb > summary.markers[1].meanProb);
});

test('v2: a failing backend falls back to the next one for that and later networks', async () => {
  const calls = [];
  const logs = [];
  const result = await runInference(v2Input, {
    folds: [0, 1], backends: ['webgpu', 'wasm'], threshold: 0.5,
    qsm: { makehomogeneous_wasm: data => data },
    loadModel: async asset => asset.fold,
    Tensor: class { constructor(type, data) { this.data = data; } },
    createSession: async (fold, backend) => {
      calls.push([fold, backend]);
      if (backend === 'webgpu') throw new Error('no 3D Conv');
      return fakeNetwork(fold, () => [], []);
    },
    events: { log: message => logs.push(message) },
  });
  assert.deepEqual(calls, [[0, 'webgpu'], [0, 'wasm'], [1, 'wasm']]);
  assert.ok(logs.some(message => /webgpu failed \(no 3D Conv\); using wasm/.test(message)));
  assert.equal(result.detections.nCandidates, 0);
});

test('v2 rejects unknown or repeated networks and models', async () => {
  for (const folds of [[], [5], [0, 0]]) await assert.rejects(runInference(v2Input, { folds }), /network/);
  await assert.rejects(runInference(v2Input, { model: 'v3' }), /Unknown SeedSeg model/);
});

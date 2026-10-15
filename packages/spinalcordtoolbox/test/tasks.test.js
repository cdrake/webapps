import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { INFERENCE_DEFAULTS as APP_DEFAULTS } from '../../../apps/spinalcordtoolbox/web/js/app/config.js';
import { INFERENCE_DEFAULTS, getTask, modelAsset, resultFileName, runSettings, runnableTasks } from '../src/tasks.js';

test('the task inventory is the web app manifest, byte for byte', async () => {
  const app = await readFile(new URL('../../../apps/spinalcordtoolbox/web/models/manifest.json', import.meta.url));
  const copy = await readFile(new URL('../model.manifest.json', import.meta.url));
  assert.ok(copy.equals(app), 'cp apps/spinalcordtoolbox/web/models/manifest.json packages/spinalcordtoolbox/model.manifest.json');
});

test('defaults a model leaves unset are the web app defaults', () => {
  for (const [key, value] of Object.entries(INFERENCE_DEFAULTS)) assert.equal(APP_DEFAULTS[key], value, key);
});

test('every runnable task has a pinned, checksummed Hugging Face model', () => {
  assert.deepEqual(runnableTasks().map(({ id }) => id), ['spinalcord', 'graymatter', 'lesion_sci_t2', 'lesion_ms', 'spine']);
  for (const task of runnableTasks()) {
    const asset = modelAsset(task);
    assert.match(asset.url, /^https:\/\/huggingface\.co\/datasets\/sbollmann\/sct-webapp-data\/resolve\/[0-9a-f]{40}\/web\/models\/[\w.-]+\.onnx$/, task.id);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, task.id);
    assert.ok(asset.bytes > 100_000_000, task.id);
  }
  assert.throws(() => getTask('rootlets'), /Unknown or unsupported task "rootlets"/);
});

test('run settings follow the web app runSegmentation()', () => {
  assert.deepEqual(runSettings(getTask('spinalcord')), {
    taskId: 'spinalcord',
    supportStatus: 'supported',
    overlap: 0.5,
    threshold: 0.5,
    minComponentSize: 0,
    keepLargestComponent: true,
    testTimeAugmentation: false,
    patchSize: [160, 224, 64],
    preprocessing: { modelOrientation: 'RPI', modelAxisOrder: 'zyx', targetSpacing: [0.8958333, 0.7, 1] },
    output: {},
  });
  const sci = runSettings(getTask('lesion_sci_t2'), { threshold: 0.3, minimumComponentSize: 5, testTimeAugmentation: true });
  assert.equal(sci.overlap, INFERENCE_DEFAULTS.overlap, 'a model without an overlap uses the app default');
  assert.equal(sci.keepLargestComponent, false);
  assert.deepEqual([sci.threshold, sci.minComponentSize, sci.testTimeAugmentation], [0.3, 5, true]);
  assert.equal(sci.output.activation, 'sigmoid-regions');
  assert.throws(() => runSettings(getTask('spinalcord'), { threshold: 0.9 }), /between 0.01 and 0.5/);
  assert.throws(() => runSettings(getTask('spinalcord'), { minimumComponentSize: -1 }), /non-negative integer/);
  assert.equal(resultFileName('spine', 'spine_discs'), 'spine_spine_discs.nii');
});

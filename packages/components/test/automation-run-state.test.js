import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createRunState } from '../src/automation/index.js';

function fixture(t) {
  const dom = new JSDOM('<span id="statusText"></span>');
  t.after(() => dom.window.close());
  const statusElement = dom.window.document.getElementById('statusText');
  const runs = createRunState({ app: 'test', appVersion: '0.1.20260928', statusElement });
  const read = () => JSON.parse(dom.window.document.getElementById('neurodesk-run').textContent);
  return { runs, statusElement, read };
}

const image = () => new File(['scan'], 'input.nii');
const result = file => ({ artifacts: { labels: { file, type: 'neuro:label-map' } }, provenance: { model: 'test-model' } });

test('publishes explicit states and a report whose checksums describe the actual files', async t => {
  const { runs, statusElement, read } = fixture(t);
  assert.equal(read().state, 'idle');
  const loading = runs.begin('loading');
  assert.equal(loading.ready(), true);
  const readyId = read().runId;
  const parameters = { fast: true };
  const run = runs.begin('running', { inputs: { image: image() }, parameters });
  parameters.fast = false;
  run.progress({ message: 'Fitting', value: 0.5 });
  assert.equal(read().message, 'Fitting');
  assert.notEqual(read().runId, readyId);
  const file = new File(['labels'], 'labels.nii', { type: 'application/x-nifti' });
  assert.equal(await run.succeed(result(file)), true);
  const report = read().report;
  assert.equal(statusElement.dataset.neurodeskState, 'succeeded');
  assert.equal(statusElement.dataset.neurodeskRunId, report.runId);
  assert.equal(report.parameters.fast, true);
  assert.equal(report.inputs.image.sha256, createHash('sha256').update('scan').digest('hex'));
  assert.equal(report.artifacts.labels.sha256, createHash('sha256').update('labels').digest('hex'));
  assert.equal(report.artifacts.labels.bytes, 6);
  assert.equal(report.artifacts.labels.mediaType, 'application/x-nifti');
  assert.equal(run.fail('late error'), false);
  assert.equal(runs.cancel(), false);
  const snapshot = runs.snapshot();
  snapshot.report.parameters.fast = false;
  assert.equal(read().report.parameters.fast, true);
});

test('cancellation while reading an artifact cannot publish success', async t => {
  const { runs, read } = fixture(t);
  let release;
  const file = new File(['labels'], 'labels.nii');
  file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  const run = runs.begin('running');
  const pending = run.succeed(result(file));
  assert.equal(runs.cancel(), true);
  assert.equal(run.signal.aborted, true);
  release(new TextEncoder().encode('labels').buffer);
  assert.equal(await pending, false);
  assert.equal(read().state, 'cancelled');
  assert.equal(read().report, undefined);
  assert.equal(run.progress({ message: 'Old progress' }), false);
});

test('replacing a run invalidates an old asynchronous completion and error', async t => {
  const { runs, read } = fixture(t);
  let release;
  const file = new File(['old'], 'old.nii');
  file.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  const old = runs.begin('running');
  const pending = old.succeed(result(file));
  const fresh = runs.begin('loading');
  fresh.ready('New input ready');
  const expected = read();
  release(new TextEncoder().encode('old').buffer);
  assert.equal(await pending, false);
  assert.equal(old.fail('Old worker failed'), false);
  assert.deepEqual(read(), expected);
});

test('input replacement clears successful reports and errors before work starts', async t => {
  const { runs, read } = fixture(t);
  const run = runs.begin('running');
  await run.succeed(result(new File(['labels'], 'labels.nii')));
  const next = runs.begin('loading');
  assert.equal(read().report, undefined);
  next.fail('Input is invalid');
  assert.equal(read().message, 'Input is invalid');
  runs.begin('loading');
  assert.equal(read().state, 'loading');
  assert.equal(read().message, '');
});

test('empty artifacts fail explicitly and never yield a report', async t => {
  const { runs, read } = fixture(t);
  const run = runs.begin('running');
  await assert.rejects(run.succeed(result(new File([], 'empty.nii'))), /output is empty/);
  assert.equal(read().state, 'failed');
  assert.equal(read().report, undefined);
});

test('hashes input and output files sequentially', async t => {
  const { runs } = fixture(t);
  const order = [];
  const file = name => {
    const value = new File([name], name);
    const read = value.arrayBuffer.bind(value);
    value.arrayBuffer = async () => {
      order.push(name);
      return read();
    };
    return value;
  };
  const run = runs.begin('running', { inputs: { image: file('input') } });
  await run.succeed({ artifacts: { brain: { file: file('brain') }, mask: { file: file('mask') } } });
  assert.deepEqual(order, ['input', 'brain', 'mask']);
});

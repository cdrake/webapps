import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitPipelineStep } from '../src/automation/pipeline.js';

const executor = () => ({ onStepComplete() {}, onComplete() {}, onError() {}, cancel() { this.cancelled = true; } });

test('step automation waits for actual completion instead of command dispatch', async () => {
  const pipeline = executor();
  const controller = new AbortController();
  let complete = false;
  const run = awaitPipelineStep(pipeline, { step: 'load' }, async () => {}, controller.signal).then(() => { complete = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(complete, false);
  pipeline.onStepComplete('n4');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(complete, false);
  pipeline.onStepComplete('load');
  await run;
});

test('step automation observes final inference callback and restores UI handlers', async () => {
  const pipeline = executor();
  const original = pipeline.onComplete;
  const run = awaitPipelineStep(pipeline, { step: 'inference', terminal: 'complete' }, async () => pipeline.onComplete({}), new AbortController().signal);
  await run;
  assert.equal(pipeline.onComplete, original);
});

test('worker failures and cancellation reject pending automation', async () => {
  const failed = executor();
  await assert.rejects(awaitPipelineStep(failed, { step: 'load' }, () => failed.onError('bad image'), new AbortController().signal), /bad image/);
  const pipeline = executor();
  const controller = new AbortController();
  const running = awaitPipelineStep(pipeline, { step: 'load' }, () => controller.abort(), controller.signal);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(pipeline.cancelled, true);
});

test('UI callbacks retain their executor receiver and thrown errors reject automation', async () => {
  const pipeline = executor();
  pipeline.onStepComplete = function () {
    assert.equal(this, pipeline);
    throw new Error('viewer failed');
  };
  await assert.rejects(awaitPipelineStep(pipeline, { step: 'load' }, () => pipeline.onStepComplete('load'), new AbortController().signal), /viewer failed/);
});

test('terminal callback is explicit and concurrent waits cannot replace each other', async () => {
  const pipeline = { cancel() {} };
  const signal = new AbortController().signal;
  let completed = false;
  const run = awaitPipelineStep(pipeline, { step: 'inference', terminal: 'complete' }, () => pipeline.onStepComplete('inference'), signal).then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(completed, false);
  await assert.rejects(awaitPipelineStep(pipeline, { step: 'load' }, () => {}, signal), /pending automation step/);
  pipeline.onComplete();
  await run;
  assert.equal(pipeline.onComplete, undefined);
});


test('named pipeline callbacks use the same completion and error boundary', async () => {
  const pipeline = { onPipelineComplete() {}, onPipelineError() {} };
  const original = pipeline.onPipelineComplete;
  const options = { terminal: 'complete', completionCallback: 'onPipelineComplete', errorCallback: 'onPipelineError' };
  await awaitPipelineStep(pipeline, options, () => pipeline.onPipelineComplete(), new AbortController().signal);
  assert.equal(pipeline.onPipelineComplete, original);
  await assert.rejects(awaitPipelineStep(pipeline, options, () => pipeline.onPipelineError('QSM failed'), new AbortController().signal), /QSM failed/);
});

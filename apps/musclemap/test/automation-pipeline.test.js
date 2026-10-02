import assert from 'node:assert/strict';
import test from 'node:test';
import { MuscleMapPipeline } from '../web/js/controllers/MuscleMapPipeline.js';

function pipeline() {
  return new MuscleMapPipeline({ updateOutput() {} });
}

test('automation observes completion even when the worker completes during dispatch', async () => {
  const executor = pipeline();
  executor.executeCommand = async () => executor.onComplete({});
  assert.equal(await executor.run({}), true);
  assert.equal(executor.pendingTask, null);
});

test('automation propagates worker failures and permits the next task', async () => {
  const executor = pipeline();
  executor.executeCommand = async () => executor.onError('invalid image');
  await assert.rejects(executor.run({}), /invalid image/);
  executor.executeCommand = async () => executor.onComplete({});
  assert.equal(await executor.calculateMetrics({}), true);
});

test('automation rejects concurrent tasks and preserves the active completion', async () => {
  const executor = pipeline();
  executor.executeCommand = async () => {};
  const active = executor.run({});
  await assert.rejects(executor.calculateMetrics({}), /already running/);
  executor.onComplete({});
  assert.equal(await active, true);
});

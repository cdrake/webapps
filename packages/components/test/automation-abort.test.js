import test from 'node:test';
import assert from 'node:assert/strict';
import { runAbortable } from '../src/automation/abort.js';

test('abort releases the owned worker and rejects a pending operation without exposing its late output', async () => {
  const controller = new AbortController();
  let finish;
  let cancelled = 0;
  const operation = runAbortable(controller.signal, () => new Promise(resolve => { finish = resolve; }), () => { cancelled++; });
  await Promise.resolve();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  finish('stale output');
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(cancelled, 1);
});

test('already aborted requests never launch work and completed tasks are not cancelled later', async () => {
  const controller = new AbortController();
  let cancelled = 0;
  assert.equal(await runAbortable(controller.signal, async () => 42, () => { cancelled++; }), 42);
  controller.abort();
  await assert.rejects(runAbortable(controller.signal, () => assert.fail('must not start'), () => { cancelled++; }), { name: 'AbortError' });
  assert.equal(cancelled, 0);
});

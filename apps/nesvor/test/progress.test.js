import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressReporter, formatProgress } from '../src/progress.js';

test('formats measured batch, download and registration details', () => {
  assert.equal(formatProgress({ stage: 'training-batch', iteration: 2, iterations: 6000, completed: 128, total: 4096 }), 'Training · iteration 2/6000 · 128/4096 observations');
  assert.match(formatProgress({ stage: 'svort-model-download', model: 0, received: 1048576, total: 2097152 }), /model 1 · 1.0\/2.0 MB/);
  assert.match(formatProgress({ stage: 'svort', iteration: 1, total: 4, phase: 'Backprojecting slices' }), /iteration 1\/4 · Backprojecting slices/);
});

test('throttles logs without losing live updates or final completion', () => {
  let time = 0;
  const logs = [];
  const displays = [];
  const reporter = createProgressReporter({ log: line => logs.push(line), display: (...args) => displays.push(args), now: () => time });
  reporter.update({ stage: 'training-batch', iteration: 1, iterations: 2, completed: 0, total: 4 });
  time = 100;
  reporter.update({ stage: 'training-batch', iteration: 1, iterations: 2, completed: 4, total: 4 });
  assert.equal(logs.length, 1);
  assert.equal(displays.length, 2);
  assert.equal(displays[0][1], undefined);
  time = 3100;
  reporter.update({ stage: 'training', step: 1, iterations: 2, losses: { MSE: 0.02 }, fraction: 0.5 });
  assert.match(logs.at(-1), /loss 0.02000/);
  reporter.update({ stage: 'training', step: 2, iterations: 2, fraction: 0.85 });
  assert.match(logs.at(-1), /iteration 2\/2/);
  reporter.update({ stage: 'complete', fraction: 1 });
  assert.equal(displays.at(-1)[1], 1);
  assert.equal(reporter.text(), logs.join('\n'));
});

test('quiet notices describe missing worker reports without inventing progress', () => {
  let time = 0;
  const logs = [];
  const reporter = createProgressReporter({ log: line => logs.push(line), display() {}, now: () => time });
  reporter.update({ stage: 'bias-correction', completed: 0, total: 3 });
  time = 15000;
  reporter.checkQuiet();
  assert.match(logs.at(-1), /No new worker update for 15s. Last report: N4 bias correction/);
  reporter.checkQuiet();
  assert.equal(logs.length, 2);
  reporter.update({ stage: 'bias-correction', completed: 1, total: 3 });
  time = 16000;
  reporter.checkQuiet();
  assert.equal(logs.length, 2);
});

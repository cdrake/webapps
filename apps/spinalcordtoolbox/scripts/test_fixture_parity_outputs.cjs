#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./batch-parity-fixtures.cjs');
const { loadNifti } = require('./batch-parity-lib.cjs');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');
const manifest = require('../web/models/manifest.json');
const { CRITICAL_BROWSER_OUTPUTS, assertMaskParity, assertMsLesionMetrics, assertSciLesionMetrics } = require('./parity-gates.cjs');

const ROOT = path.resolve(__dirname, '..');

function fixtureForCheck(check) {
  return fixtures.FIXTURE_CASES.find(item => item.id === (check.fixtureId || check.id));
}

function browserOutputPathForCheck(check, fixture) {
  if (check.stage && fixture.browserOutputPaths?.[check.stage]) {
    return path.join(ROOT, fixture.browserOutputPaths[check.stage]);
  }
  return path.join(ROOT, path.dirname(fixture.inputPath), 'browser_output.nii.gz');
}

function expectedOutputPathForCheck(check, fixture) {
  if (check.stage && fixture.expectedOutputPaths?.[check.stage]) {
    return path.join(ROOT, fixture.expectedOutputPaths[check.stage]);
  }
  return path.join(ROOT, fixture.expectedOutputPath);
}

function assertLesionMetricsFixture() {
  const fixture = fixtures.FIXTURE_CASES.find(item => item.id === 'batch_t2_deepseg_lesion_sci_t2');
  assert.ok(fixture, 'SCI lesion fixture exists for metrics validation');
  assertSciLesionMetrics({
    expectedCord: expectedOutputPathForCheck({ stage: 'segmentation' }, fixture),
    expectedLesion: expectedOutputPathForCheck({ stage: 'lesion' }, fixture),
    producedCord: browserOutputPathForCheck({ stage: 'segmentation' }, fixture),
    producedLesion: browserOutputPathForCheck({ stage: 'lesion' }, fixture)
  });
}

function assertMsLesionMetricsFixture() {
  const fixture = fixtures.FIXTURE_CASES.find(item => item.id === 'course_t2_ms_deepseg_lesion_ms');
  assert.ok(fixture, 'MS lesion fixture exists for metrics validation');
  assertMsLesionMetrics({
    expectedLesion: expectedOutputPathForCheck({ stage: 'lesion' }, fixture),
    producedLesion: browserOutputPathForCheck({ stage: 'lesion' }, fixture)
  });
}

const supportedTasks = new Set(
  manifest.tasks
    .filter(task => task.supportStatus === 'supported' && task.validationStatus === 'passed')
    .map(task => task.id)
);

function missingBrowserOutputs() {
  return CRITICAL_BROWSER_OUTPUTS
    .map(check => ({ check, fixture: fixtureForCheck(check) }))
    .filter(item => item.fixture)
    .map(({ check, fixture }) => browserOutputPathForCheck(check, fixture))
    .filter(filePath => !fs.existsSync(filePath));
}

function staleBrowserOutputs() {
  const stale = [];
  for (const check of CRITICAL_BROWSER_OUTPUTS) {
    const fixture = fixtureForCheck(check);
    if (!fixture) continue;
    const producedPath = browserOutputPathForCheck(check, fixture);
    if (!fs.existsSync(producedPath)) continue;
    const produced = loadNifti(producedPath);
    let producedNz = 0;
    for (let i = 0; i < produced.data.length; i++) {
      if (produced.data[i] > 0) producedNz++;
    }
    if (producedNz === 0) {
      const expectedPath = expectedOutputPathForCheck(check, fixture);
      if (!fs.existsSync(expectedPath)) continue;
      const expected = loadNifti(expectedPath);
      let expectedNz = 0;
      for (let i = 0; i < expected.data.length; i++) {
        if (expected.data[i] > 0) expectedNz++;
      }
      if (expectedNz > 0) stale.push(producedPath);
    }
  }
  return stale;
}

function ensureBrowserOutputs() {
  const force = process.env.BROWSER_FIXTURE_REGENERATE === '1';
  if (!force && missingBrowserOutputs().length === 0 && staleBrowserOutputs().length === 0) return;

  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_browser_fixture_outputs.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'browser fixture output generation exits successfully');
}

(async () => {
  await ensureSctBatchFixtures(ROOT);
  ensureBrowserOutputs();

  for (const taskId of supportedTasks) {
    assert.ok(
      CRITICAL_BROWSER_OUTPUTS.some(item => item.taskId === taskId),
      `supported task ${taskId} has at least one browser-output parity fixture`
    );
  }

  const results = [];
  for (const check of CRITICAL_BROWSER_OUTPUTS) {
    const fixture = fixtureForCheck(check);
    assert.ok(fixture, `${check.id} fixture exists`);

    const expectedPath = expectedOutputPathForCheck(check, fixture);
    const producedPath = browserOutputPathForCheck(check, fixture);
    assert.notEqual(path.resolve(expectedPath), path.resolve(producedPath), `${check.id}: produced output is not the expected fixture`);
    assert.ok(fs.existsSync(producedPath), `${check.id}: browser output exists at ${path.relative(ROOT, producedPath)}`);

    const stats = assertMaskParity(check, expectedPath, producedPath);
    results.push(`${check.id}: dice=${stats.dice.toFixed(4)} expectedNz=${stats.expectedNz} producedNz=${stats.producedNz}`);
  }
  assertLesionMetricsFixture();
  assertMsLesionMetricsFixture();

  console.log(`Browser fixture parity passed:\n${results.join('\n')}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

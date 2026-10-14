'use strict';

/*
 * Parity gates against SCT's own outputs, shared by the browser fixture test
 * (test_fixture_parity_outputs.cjs) and the sct-webapp command line's release
 * check (packages/spinalcordtoolbox/validation/cli-check.mjs). Gates only tighten.
 */
const assert = require('node:assert/strict');
const { loadNifti } = require('./batch-parity-lib.cjs');
const lesionAnalysis = require('@neurodesk/spinalcordtoolbox/lesion-analysis');

const CRITICAL_BROWSER_OUTPUTS = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2_sc',
    fixtureId: 'batch_t2_deepseg_lesion_sci_t2',
    stage: 'segmentation',
    taskId: 'lesion_sci_t2',
    minDice: 0.8,
    foregroundRatioTolerance: 0.35
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2_lesion',
    fixtureId: 'batch_t2_deepseg_lesion_sci_t2',
    stage: 'lesion',
    taskId: 'lesion_sci_t2',
    minDice: 0.6,
    foregroundRatioTolerance: 0.75
  },
  {
    id: 'course_t2_ms_deepseg_lesion_ms_lesion',
    fixtureId: 'course_t2_ms_deepseg_lesion_ms',
    stage: 'lesion',
    taskId: 'lesion_ms',
    // Measured 0.8255 (171 vs 190 voxels) against SCT 7.3 `lesion_ms -single-fold`.
    minDice: 0.75,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.8,
    foregroundRatioTolerance: 0.5
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    taskId: 'graymatter',
    minDice: 0.7,
    foregroundRatioTolerance: 0.15
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.85,
    foregroundRatioTolerance: 0.2
  }
]);

function diceStats(expected, produced) {
  let expectedNz = 0;
  let producedNz = 0;
  let intersection = 0;
  for (let i = 0; i < expected.data.length; i++) {
    const e = expected.data[i] > 0;
    const p = produced.data[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  return {
    expectedNz,
    producedNz,
    intersection,
    dice: expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1
  };
}

/** One mask against SCT's: grid, spacing and uint8 labels, then foreground and Dice gates. */
function assertMaskParity(check, expectedPath, producedPath) {
  const expected = loadNifti(expectedPath);
  const produced = loadNifti(producedPath);
  assert.equal(
    expected.header.dims.slice(0, 4).join('x'),
    produced.header.dims.slice(0, 4).join('x'),
    `${check.id}: output dimensions match the SCT reference`
  );
  assert.equal(
    expected.header.pixDims.slice(1, 4).join('x'),
    produced.header.pixDims.slice(1, 4).join('x'),
    `${check.id}: output spacing matches the SCT reference`
  );
  assert.equal(produced.header.datatypeCode, 2, `${check.id}: output is uint8 label data`);

  const stats = diceStats(expected, produced);
  const lower = stats.expectedNz * (1 - check.foregroundRatioTolerance);
  const upper = stats.expectedNz * (1 + check.foregroundRatioTolerance);
  assert.ok(stats.producedNz >= lower && stats.producedNz <= upper, `${check.id}: foreground ${stats.producedNz} is within tolerance of ${stats.expectedNz}`);
  assert.ok(stats.dice >= check.minDice, `${check.id}: Dice ${stats.dice.toFixed(4)} >= ${check.minDice.toFixed(4)}`);
  return stats;
}

function lesionMetricsFor(lesionPath, spinalCordPath = null) {
  const lesion = loadNifti(lesionPath);
  return lesionAnalysis.analyzeLesions({
    spinalCord: spinalCordPath ? loadNifti(spinalCordPath).data : null,
    lesion: lesion.data,
    dims: lesion.header.dims.slice(1, 4),
    spacing: lesion.header.pixDims.slice(1, 4).map(value => Math.abs(value) || 1)
  });
}

function assertRelativeClose(actual, expected, tolerance, label) {
  const allowed = Math.max(Math.abs(expected) * tolerance, tolerance);
  assert.ok(Math.abs(actual - expected) <= allowed, `${label}: ${actual} is within ${tolerance * 100}% of ${expected}`);
}

// SCIseg on SCT's fake-lesion image: metrics of the cord-restricted lesion.
function assertSciLesionMetrics({ expectedCord, expectedLesion, producedCord, producedLesion }) {
  const expectedMetrics = lesionMetricsFor(expectedLesion, expectedCord);
  const producedMetrics = lesionMetricsFor(producedLesion, producedCord);
  assert.ok(producedMetrics.csv.includes('dorsal_bridge_width_mm'), 'lesion metrics CSV includes tissue-bridge columns');
  assert.ok(producedMetrics.summary.lesion_count >= expectedMetrics.summary.lesion_count, 'metrics preserve the expected SCI lesion component');
  assert.ok(producedMetrics.summary.lesion_count <= expectedMetrics.summary.lesion_count + 1, 'metrics do not add more than one small extra component on the fake-lesion fixture');
  assertRelativeClose(producedMetrics.summary.total_volume_mm3, expectedMetrics.summary.total_volume_mm3, 0.25, 'lesion total volume');
  assertRelativeClose(producedMetrics.summary.total_length_mm, expectedMetrics.summary.total_length_mm, 0.25, 'lesion total length');
  assertRelativeClose(producedMetrics.summary.max_width_mm, expectedMetrics.summary.max_width_mm, 0.30, 'lesion max width');
  return { expected: expectedMetrics.summary, produced: producedMetrics.summary };
}

// lesion_ms has no cord mask, so the metrics are lesion-only. SCT 7.3 finds 5
// lesions (673.5 mm3) on the course MS image; the browser finds 4 (606.2 mm3),
// missing the smallest one (8 voxels).
function assertMsLesionMetrics({ expectedLesion, producedLesion }) {
  const expectedMetrics = lesionMetricsFor(expectedLesion);
  const producedMetrics = lesionMetricsFor(producedLesion);
  assert.equal(expectedMetrics.summary.lesion_count, 5, 'SCT reference lesion count on the MS fixture');
  assert.ok(Math.abs(producedMetrics.summary.lesion_count - expectedMetrics.summary.lesion_count) <= 1, `MS lesion count ${producedMetrics.summary.lesion_count} is within one of ${expectedMetrics.summary.lesion_count}`);
  assertRelativeClose(producedMetrics.summary.total_volume_mm3, expectedMetrics.summary.total_volume_mm3, 0.2, 'MS lesion total volume');
  assert.ok(!producedMetrics.csv.includes('sagittal_x_'), 'lesion-only metrics CSV has no tissue-bridge columns');
  return { expected: expectedMetrics.summary, produced: producedMetrics.summary };
}

module.exports = {
  CRITICAL_BROWSER_OUTPUTS,
  assertMaskParity,
  assertMsLesionMetrics,
  assertSciLesionMetrics,
  diceStats
};

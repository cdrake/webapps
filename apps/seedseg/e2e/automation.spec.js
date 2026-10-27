import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { dice, maskVoxels } from '../../../test-utils/dice.mjs';
import { markerComponents, matchComponentsToSeeds } from '../test/marker-components.mjs';
import { createProstateFixture, createProstateSeedMask, PROSTATE_FIXTURE_DIMS, PROSTATE_FIXTURE_SEEDS } from '../test/prostate-fixture.mjs';

const image = createProstateFixture();

// Ground truth is the fixture's own geometry (three planted cylinders), not an earlier app output.
// Measured 2026-10-03 (ONNX Runtime Web 1.21.0, WASM): three components of 280, 233 and 280 voxels,
// centroids 0.14, 0.18 and 0.20 voxels from the planted coordinates, every planted voxel marked.
// Dice against the 117 planted voxels is only 0.26 because the models outline a wider artefact than
// the planted void, so localisation, count and coverage are asserted and Dice is logged, not gated.
const MAX_CENTROID_DISTANCE_VOXELS = 1;
const MIN_PLANTED_RECALL = 0.9;
const MAX_MARKER_VOXELS_PER_PLANTED_VOXEL = 10;

const dicompareEmbed = fileURLToPath(new URL('../../dicompare/public/embed/', import.meta.url));

// The page imports dicompare's embed from its site; serve the monorepo's copy, as the standalone bundle does.
test.beforeEach(async ({ context }) => {
  await context.route('https://dicompare.neurodesk.org/embed/**', route => route.fulfill({
    path: join(dicompareEmbed, new URL(route.request().url()).pathname.slice('/embed/'.length)),
    headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' },
  }));
});

async function runSegmentation(page, parameters = {}) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'synthetic-prostate-t1.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(values => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters: values }), parameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  return page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
}

async function downloadRow(page, row) {
  const waiting = page.waitForEvent('download');
  await row.locator('.download-btn').click();
  const download = await waiting;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

// v2 is trained on N4-corrected clinical T1 at 0.6875 x 0.6875 x 2 mm; this 1 mm phantom is off its
// protocol. Measured 2026-10-27 (ONNX Runtime Web 1.21.0, WASM): network 1 marks one of the three
// planted seeds (159 voxels, centroid 0.25 voxels away, mean probability 0.58) and flags the count.
test('the default v2 network reports only planted fiducials and flags the missing ones', async ({ page }) => {
  test.setTimeout(600000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = await runSegmentation(page);
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.provenance.model).toBe('v2');
  expect(snapshot.report.provenance.models.map(model => model.name)).toEqual(['seedseg-v2_fold0.wg16.onnx']);
  const { detections } = snapshot.report.measurements;
  expect(detections.markers.length).toBeGreaterThanOrEqual(1);
  expect(detections.countFlag).toBe(detections.nCandidates < 3);
  const kinds = {};
  for (const [id, artifact] of Object.entries(snapshot.report.artifacts)) {
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    const bytes = await readFile(await (await waiting).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    const volume = await readNifti(bytes);
    expect(volume.dims).toEqual(PROSTATE_FIXTURE_DIMS);
    kinds[artifact.role] = volume.data;
  }
  expect(Object.keys(kinds).sort()).toEqual(['markers', 'probability']);
  expect(kinds.probability.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  for (const [rank, marker] of detections.markers.entries()) {
    const voxels = kinds.markers.filter(value => value === rank + 1).length;
    expect(voxels).toBe(marker.nVoxels);
    const distance = Math.min(...PROSTATE_FIXTURE_SEEDS.map(seed => Math.hypot(...marker.centroidVox.map((value, axis) => value - seed[axis]))));
    expect(distance, `marker ${rank + 1} on a planted seed`).toBeLessThanOrEqual(MAX_CENTROID_DISTANCE_VOXELS);
  }
  const panel = page.locator('#detectionsPanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.nd-message')).toHaveText(detections.countFlag
    ? new RegExp(`^Check: ${detections.markers.length} of 3 markers found`)
    : /^3 of 3 markers found/);
  await expect(panel.locator('tbody tr')).toHaveCount(detections.markers.length);
  await panel.getByRole('button', { name: 'Show marker 1' }).click();
  expect(errors).toEqual([]);
});

test('the legacy v1 ensemble finds the three planted fiducials of the synthetic prostate fixture', async ({ page }) => {
  test.setTimeout(600000);
  const snapshot = await runSegmentation(page, { model: 'v1' });
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.image[0].sha256).toBe(createHash('sha256').update(image).digest('hex'));
  expect(snapshot.report.provenance.models).toHaveLength(4);
  expect(Object.values(snapshot.report.artifacts).filter(artifact => artifact.role === 'probability')).toHaveLength(5);
  let markerMasks = 0;
  for (const [id, artifact] of Object.entries(snapshot.report.artifacts)) {
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    const bytes = await readFile(await (await waiting).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    const volume = await readNifti(bytes);
    expect(volume.dims).toEqual(PROSTATE_FIXTURE_DIMS);
    expect(volume.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    if (artifact.role !== 'markers') continue;
    expect(volume.data.every(value => value === 0 || value === 1)).toBe(true);
    const components = markerComponents(volume.data, PROSTATE_FIXTURE_DIMS);
    const planted = createProstateSeedMask();
    const seedDice = dice(volume.data, planted);
    const plantedVoxels = maskVoxels(planted);
    const plantedRecall = planted.reduce((sum, value, index) => sum + (value && volume.data[index] ? 1 : 0), 0) / plantedVoxels;
    console.log(JSON.stringify({ seedDice, plantedRecall, plantedVoxels, components }));
    expect(components).toHaveLength(PROSTATE_FIXTURE_SEEDS.length);
    for (const match of matchComponentsToSeeds(components, PROSTATE_FIXTURE_SEEDS)) {
      expect(match.distance, `marker for planted seed ${match.seed.join(',')}`).toBeLessThanOrEqual(MAX_CENTROID_DISTANCE_VOXELS);
    }
    expect(plantedRecall).toBeGreaterThanOrEqual(MIN_PLANTED_RECALL);
    expect(maskVoxels(volume.data)).toBeLessThanOrEqual(MAX_MARKER_VOXELS_PER_PLANTED_VOXEL * plantedVoxels);
    markerMasks++;
  }
  expect(markerMasks).toBe(1);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-seedseg-automation');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify({ validation: 'Synthetic fixture with three planted fiducials; marker localisation is checked against the planted coordinates. No clinical accuracy claim.', report: snapshot.report }, null, 2));
});

test('the v2 marker mask can be corrected in the viewer and downloads edited', async ({ page }) => {
  test.setTimeout(600000);
  expect((await runSegmentation(page)).state).toBe('succeeded');
  const row = page.locator('#stage-item-markers');
  const label = row.locator('.stage-btn');
  const edit = row.getByRole('button', { name: 'Edit', exact: true });
  const editor = page.locator('nd-mask-editor');
  const original = await downloadRow(page, row);

  await edit.click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toHaveText('Editing Markers. Left-drag paints; Apply keeps the changes.');
  await expect(edit).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Markers');
  await expect(edit).toBeEnabled();
  expect((await downloadRow(page, row)).bytes.equals(original.bytes)).toBe(true);

  await page.locator('.view-tab[data-view="axial"]').click();
  await edit.click();
  await expect(editor).toBeVisible();
  const box = await page.locator('#gl1').boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x - 60, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 12 });
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Markers (edited)');
  await expect(page.locator('#statusText')).toHaveText('Ready');

  const edited = await downloadRow(page, row);
  expect(edited.name).toBe(original.name);
  const header = new DataView(edited.bytes.buffer, edited.bytes.byteOffset, edited.bytes.byteLength);
  expect(header.getInt16(70, true)).toBe(2);
  const before = await readNifti(original.bytes);
  const after = await readNifti(edited.bytes);
  expect(after.dims).toEqual(PROSTATE_FIXTURE_DIMS);
  expect(after.data.some((value, index) => value !== before.data[index])).toBe(true);

  await edit.click();
  await expect(editor).toBeVisible();
  await page.locator('#clearResults').click();
  await expect(editor).toBeHidden();
  await expect(row).toHaveCount(0);
});

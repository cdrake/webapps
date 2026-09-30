import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import examples from '../examples.json' with { type: 'json' };

async function start(page, file) {
  await page.goto('./');
  await expect(page.locator('#statusText')).toContainText('Ready', { timeout: 120_000 });
  await page.locator('#neurodesk-input-transfer').setInputFiles(file);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'lesion' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'analyze' }));
}

test('automation rejects a lesion outside the atlas grid and publishes no artifacts', async ({ page }) => {
  test.setTimeout(360_000);
  const buffer = await readFile(new URL('../../../exes/nii2tvx/test/fixtures/lesion.nii.gz', import.meta.url));
  await start(page, { name: 'wrong-grid.nii.gz', mimeType: 'application/gzip', buffer });
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 300_000 }).toBe('failed');
  const result = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(result.error.message).toContain('SYNcro');
  expect(result.report).toBeUndefined();
});

test('real query returns the CLI table, verified download, atlas provenance and viewer regions', async ({ page, request }) => {
  test.skip(!process.env.DISCONNECTOME_LIVE_DATA, 'Set DISCONNECTOME_LIVE_DATA=1 for the published atlas and example.');
  test.setTimeout(600_000);
  const file = examples.find((example) => example.id === 'wm2208').files.find((file) => file.role === 'image');
  const response = await request.get(file.url);
  expect(response.ok()).toBe(true);
  const buffer = await response.body();
  expect(createHash('sha256').update(buffer).digest('hex')).toBe(file.sha256);
  await start(page, { name: file.name, mimeType: 'application/gzip', buffer });
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 540_000 }).toBe('succeeded');
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(report.provenance.atlas.id).toBe('enigma');
  expect(report.measurements.bundles).toHaveLength(65);
  const [artifactId, artifact] = Object.entries(report.artifacts)[0];
  const downloading = page.waitForEvent('download');
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
  const download = await downloading;
  const bytes = await readFile(await download.path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  const [header, row] = bytes.toString().trim().split('\n');
  const golden = (await readFile(new URL('../../../exes/nii2tvx/test/expected-examples-enigma.tsv', import.meta.url), 'utf8')).trim().split('\n');
  expect(header).toBe(golden[0]);
  expect(row).toBe(golden.find((line) => line.startsWith('wM2208')));
  const regions = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('viewers.regions', { viewerId: 'image' }));
  expect(regions).toHaveLength(65);
});

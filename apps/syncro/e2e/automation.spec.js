import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const image = gunzipSync(await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url)));
const shifted = Buffer.from(image);
shifted.fill(0, 352);
shifted[352] = 1;
shifted.writeInt16LE(2, 70);
shifted.writeInt16LE(8, 72);
shifted.writeInt16LE(1, 254);
shifted.writeFloatLE(1000, 292);

test('automation rejects an explicitly paired lesion on the wrong grid before inference', async ({ page }) => {
  test.setTimeout(90_000);
  const models = [];
  page.on('request', (request) => { if (request.url().includes('.onnx')) models.push(request.url()); });
  await page.goto('./');
  for (const [role, buffer] of [['primary', image], ['lesion', shifted]]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name: `${role}.nii`, mimeType: 'application/nifti', buffer });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('failed');
  const result = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(result.error.message).toContain('must match');
  expect(result.report).toBeUndefined();
  expect(models).toEqual([]);
  await expect(page.locator('#input')).toBeEnabled();
});

test('full normalization exports all required MNI images and the real pipeline manifest', async ({ page }) => {
  test.skip(!process.env.SYNCRO_AUTOMATION_IMAGE, 'Set SYNCRO_AUTOMATION_IMAGE to a suitable anatomical scan for full inference.');
  test.setTimeout(900_000);
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles(process.env.SYNCRO_AUTOMATION_IMAGE);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'primary' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize', parameters: { synthsrBackend: 'wasm', brainExtractor: 'synthstrip', keepSynth: true } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 840_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  expect(Object.values(snapshot.report.artifacts).map(({ role }) => role).sort()).toEqual(['details','native-synthetic','normalized-brain','normalized-primary','synthetic-brain']);
  const { createHash } = await import('node:crypto');
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    if (artifact.role === 'normalized-primary') {
      const raw = bytes[0] === 31 ? gunzipSync(bytes) : bytes;
      expect([42,44,46].map((offset) => raw.readInt16LE(offset))).toEqual([182,218,182]);
    }
  }
});

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

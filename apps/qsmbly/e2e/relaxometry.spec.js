import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';
import { serveSite } from '../../../test-utils/serve-site.mjs';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';

let site;
test.beforeAll(async () => {
  site = await serveSite(new URL('../dist/', import.meta.url).pathname);
});
test.afterAll(async () => {
  await site?.close();
});

function echoes({ partialPhase = false, wrongGrid = false } = {}) {
  const files = [];
  for (let echo = 1; echo <= 3; echo++) {
    const name = `echo-${echo}_mag`;
    files.push({
      name: `${name}.nii`, mimeType: 'application/x-nifti',
      buffer: syntheticNifti({ dims: wrongGrid && echo === 2 ? [2, 4, 8] : [4, 4, 4], spacing: [1, 1, 1], gzip: false, value: () => 100 * Math.exp(-20 * echo * 0.01) }),
    });
    files.push({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ EchoTime: echo * 0.01, ImageType: ['M'] })) });
  }
  if (partialPhase) files.push({ name: 'echo-1_phase.nii', mimeType: 'application/x-nifti', buffer: syntheticNifti({ gzip: false }) });
  return files;
}

async function load(page, options) {
  await page.goto(site.origin);
  await page.waitForFunction(() => Boolean(window.neurodeskAutomation && window.app));
  await page.locator('#unifiedFiles').setInputFiles(echoes(options));
  await expect.poll(() => page.evaluate(() => window.app.fileIOController.buckets.magnitude.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.app.getEchoTimesFromInputs())).toEqual([10, 20, 30]);
  if (await page.locator('#paramsSection').evaluate(element => element.classList.contains('collapsed'))) {
    await page.locator('#paramsSection [data-disclosure-toggle]').click();
  }
  await page.locator('#magField').fill('');
  await page.locator('#swiSection [data-disclosure-toggle]').click();
}

for (const partialPhase of [false, true]) {
  test(`magnitude relaxometry needs no field strength or paired phase (${partialPhase ? 'partial phase' : 'no phase'})`, async ({ page }) => {
    await load(page, { partialPhase });
    await page.locator('#runT2starR2star').click();
    for (const [stage, expected] of [['r2star', 20], ['t2star', 0.05]]) {
      const button = page.locator(`#stage-item-${stage} .stage-download`);
      await expect(button).toBeEnabled({ timeout: 120000 });
      const pending = page.waitForEvent('download');
      await button.click();
      const volume = await readNifti(await readFile(await (await pending).path()));
      expect(volume.dims).toEqual([4, 4, 4]);
      for (const value of volume.data) expect(value).toBeCloseTo(expected, stage === 'r2star' ? 2 : 4);
    }
    await page.evaluate(() => window.app.showCommandPreview());
    await expect(page.locator('#commandPreviewText')).toContainText('This full QSM pipeline command requires paired phase and B0.');
    await expect(page.locator('#commandPreviewText')).toContainText('qsmxt r2star --help or qsmxt t2star --help');
  });
}

test('magnitude relaxometry refuses equal-length echoes on different grids', async ({ page }) => {
  await load(page, { wrongGrid: true });
  await page.locator('#runT2starR2star').click();
  await expect(page.locator('#consoleOutput')).toContainText('Magnitude echo 2 is 2x4x8 but magnitude echo 1 is 4x4x4', { timeout: 120000 });
  await expect(page.locator('#stage-item-r2star')).toHaveCount(0);
  await expect(page.locator('#runT2starR2star')).toBeEnabled();
});

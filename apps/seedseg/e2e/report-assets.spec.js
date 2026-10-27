import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const repository = new URL('../../../', import.meta.url);
const sources = JSON.parse(await readFile(new URL('registry/offline-assets.sources.json', repository), 'utf8'));
const assets = new Map(sources.apps.seedseg.filter(asset => asset.path).map(asset => [asset.url, asset]));

test.use({ serviceWorkers: 'block', userAgent: 'NeurodeskOffline/1' });

test('optional report assets resolve from the SeedSeg-only offline inventory', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#unifiedFiles').setInputFiles(dicomSeries({ series: 609 }));
  await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 90000 });

  const served = [];
  const missing = [];
  const pythonRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/_offline/python/pyodide.js') pythonRequests.push(request.url());
  });
  await page.context().route('https://**/*', async route => {
    const url = route.request().url();
    const asset = assets.get(url);
    if (!asset) {
      missing.push(url);
      return route.abort();
    }
    served.push(url);
    return route.fulfill({
      body: await readFile(new URL(asset.path, repository)),
      contentType: url.endsWith('.json') ? 'application/json' : 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' },
    });
  });

  await page.locator('#dicompareReportBtn').click();
  // This focused fixture omits Python; the real report worker must reach its local runtime.
  await expect(page.locator('#dicompareModalBody')).toContainText('Validation failed');
  expect(missing).toEqual([]);
  expect(served).toContain('https://webapps.neurodesk.org/dicompare/embed/DicompareController.js');
  expect(served).toContain('https://webapps.neurodesk.org/dicompare/embed/dicompare-worker.js');
  expect(pythonRequests).toHaveLength(1);
});

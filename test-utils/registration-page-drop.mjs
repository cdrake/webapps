import { expect } from '@playwright/test';
import { dicomSeries } from './dicom-fixture.mjs';
import { syntheticNifti } from './nifti-fixture.mjs';

const scan = name => ({ name, buffer: syntheticNifti() });

async function drop(page, files) {
  await page.evaluate(records => {
    const transfer = new DataTransfer();
    for (const record of records) transfer.items.add(new File([new Uint8Array(record.bytes)], record.name));
    document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files.map(({ name, buffer }) => ({ name, bytes: [...buffer] })));
}

async function open(page) {
  await page.goto('/');
  await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
}

export function registrationPageDropTests(test) {
  test('a page drop imports both moving and stationary images', async ({ page }) => {
    await open(page);
    await drop(page, [scan('moving.nii.gz'), scan('stationary.nii.gz')]);
    await expect(page.locator('#movingInfo')).toContainText('moving.nii.gz', { timeout: 60000 });
    await expect(page.locator('#stationaryInfo')).toContainText('stationary.nii.gz', { timeout: 60000 });
    await expect(page.locator('#stationaryInput')).toBeEnabled();
  });

  test('a page drop fills the stationary slot after the moving picker is cleared', async ({ page }) => {
    await open(page);
    await page.locator('#movingInput').setInputFiles(scan('moving.nii.gz'));
    await expect(page.locator('#movingInfo')).toContainText('moving.nii.gz', { timeout: 60000 });
    await expect(page.locator('#movingInput')).toBeEnabled();
    await drop(page, [scan('stationary.nii.gz')]);
    await expect(page.locator('#stationaryInfo')).toContainText('stationary.nii.gz', { timeout: 60000 });
    await expect(page.locator('#movingInfo')).toContainText('moving.nii.gz');
  });

  test('a failed first import leaves the moving slot available for the next drop', async ({ page }) => {
    await open(page);
    await drop(page, [{ name: 'broken.nii.gz', buffer: Buffer.from('invalid NIfTI') }]);
    await expect(page.locator('#statusText')).not.toHaveText('Drag and drop files');
    await expect(page.locator('#movingInput')).toBeEnabled({ timeout: 60000 });
    await drop(page, [scan('moving.nii.gz')]);
    await expect(page.locator('#movingInfo')).toContainText('moving.nii.gz', { timeout: 60000 });
    await expect(page.locator('#stationaryInfo')).toBeHidden();
  });

  test('a page drop keeps an extensionless DICOM series together', async ({ page }) => {
    test.setTimeout(120000);
    await open(page);
    await drop(page, dicomSeries({ extension: '' }));
    await expect(page.locator('#movingInfo')).toContainText('test_scan_1', { timeout: 60000 });
    await expect(page.locator('#movingInfo')).toContainText('.nii');
    await expect(page.locator('#movingInput')).toBeEnabled();
    await expect(page.locator('#stationaryInfo')).toBeHidden();
  });
}

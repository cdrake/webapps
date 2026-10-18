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

// The image pair's first scan input is the fixed image, so a drop fills the
// fixed slot first and the moving slot next.
export function registrationPageDropTests(test) {
  test('a page drop imports both fixed and moving images', async ({ page }) => {
    await open(page);
    await drop(page, [scan('fixed.nii.gz'), scan('moving.nii.gz')]);
    await expect(page.locator('#fixedInfo')).toContainText('fixed.nii.gz', { timeout: 60000 });
    await expect(page.locator('#movingInfo')).toContainText('moving.nii.gz', { timeout: 60000 });
    await expect(page.locator('#movingInput')).toBeEnabled();
  });

  test('a page drop fills the moving slot after the fixed image is loaded', async ({ page }) => {
    await open(page);
    await page.locator('#fixedInput').setInputFiles(scan('fixed.nii.gz'));
    await expect(page.locator('#fixedInfo')).toContainText('fixed.nii.gz', { timeout: 60000 });
    await expect(page.locator('#fixedInput')).toBeEnabled();
    await drop(page, [scan('moving.nii.gz')]);
    await expect(page.locator('#movingInfo')).toContainText('moving.nii.gz', { timeout: 60000 });
    await expect(page.locator('#fixedInfo')).toContainText('fixed.nii.gz');
  });

  test('a failed first import leaves the fixed slot available for the next drop', async ({ page }) => {
    await open(page);
    await drop(page, [{ name: 'broken.nii.gz', buffer: Buffer.from('invalid NIfTI') }]);
    await expect(page.locator('#statusText')).not.toHaveText('Drag and drop files');
    await expect(page.locator('#fixedInput')).toBeEnabled({ timeout: 60000 });
    await drop(page, [scan('fixed.nii.gz')]);
    await expect(page.locator('#fixedInfo')).toContainText('fixed.nii.gz', { timeout: 60000 });
    await expect(page.locator('#movingInfo')).toBeHidden();
  });

  test('a page drop keeps an extensionless DICOM series together', async ({ page }) => {
    test.setTimeout(120000);
    await open(page);
    await drop(page, dicomSeries({ extension: '' }));
    await expect(page.locator('#fixedInfo')).toContainText('test_scan_1', { timeout: 60000 });
    await expect(page.locator('#fixedInfo')).toContainText('.nii');
    await expect(page.locator('#fixedInput')).toBeEnabled();
    await expect(page.locator('#movingInfo')).toBeHidden();
  });
}

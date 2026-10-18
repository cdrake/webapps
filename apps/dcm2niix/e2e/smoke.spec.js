// Production browser coverage exercises actual dcm2niix WASM and downloaded ZIPs.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, strFromU8, unzipSync, zipSync } from 'fflate';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));

async function reviewAnatomical(page, type = 'T1w', privacy = 'omit') {
  await expect(page.locator('#seriesRows tr')).toHaveCount(1, { timeout: 120000 });
  await page.locator('#subject').fill('01');
  await page.locator('#session').fill('01');
  await page.locator('#privacy').selectOption(privacy);
  await page.locator('#seriesRows select').selectOption(type);
  await page.locator('#seriesRows input[type=checkbox]').check();
}
async function downloadDataset(page) {
  const pending = page.waitForEvent('download');
  await page.locator('#runButton').click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('sub-01_ses-01_bids.zip');
  return unzipSync(readFileSync(await download.path()));
}

test('boots into the shared workspace, isolated and ready for local input', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.nd-app-bar:visible')).toHaveCount(1);
  await expect(page.locator('#statusText')).toHaveText('Drag and drop files');
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await expect(page.locator('#runButton')).toBeDisabled();
});

for (const type of ['T1w', 'T2w', 'FLAIR']) {
  test(`a single ${type} exports BIDS through the real converter without other modalities`, async ({ page }) => {
    await page.goto('./');
    await page.locator('#imageInput').setInputFiles(dicomSeries());
    await reviewAnatomical(page, type);
    const entries = await downloadDataset(page);
    const path = `sub-01/ses-01/anat/sub-01_ses-01_${type}`;
    expect(JSON.parse(strFromU8(entries['dataset_description.json'])).BIDSVersion).toBe('1.11.2');
    expect(entries.README.length).toBeGreaterThan(0);
    const metadata = JSON.parse(strFromU8(entries[`${path}.json`]));
    expect(metadata.PatientName).toBeUndefined();
    expect(metadata.ProtocolName).toBeUndefined();
    const bytes = gunzipSync(entries[`${path}.nii.gz`]);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(header.getInt16(42, true)).toBe(16);
    expect(header.getInt16(44, true)).toBe(16);
    expect(header.getInt16(46, true)).toBe(4);
    expect(bytes.subarray(148, 252).every(value => value === 0)).toBe(true);
    await page.locator('#clearButton').click();
    await expect(page.locator('#seriesRows tr')).toHaveCount(0);
    await expect(page.locator('#subject')).toHaveValue('');
    await expect(page.locator('#runButton')).toBeDisabled();
  });
}

test('ZIP input and explicit retained metadata export work without persisting patient data', async ({ page }) => {
  const archive = zipSync(Object.fromEntries(dicomSeries().map(({ name, buffer }) => [`scanner/series/${name}`, buffer])));
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles({ name: 'scanner.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) });
  await reviewAnatomical(page, 'T1w', 'retain');
  const entries = await downloadDataset(page);
  const metadata = JSON.parse(strFromU8(entries['sub-01/ses-01/anat/sub-01_ses-01_T1w.json']));
  expect(metadata.PatientName).toBe('Synthetic^Phantom');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain('Synthetic');
  await page.reload();
  await expect(page.locator('#seriesRows tr')).toHaveCount(0);
  await expect(page.locator('#subject')).toHaveValue('');
});

test('missing metadata prompts for correction and changes invalidate confirmation', async ({ page }) => {
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(dicomSeries());
  await reviewAnatomical(page, 'dwi');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Supply both bval and bvec');
  await expect(page.locator('#series1-gradients')).toHaveAttribute('open', '');
  await page.locator('#series1-bval').fill('0');
  await page.locator('#series1-bvec').fill('0\n0\n0');
  await page.locator('#series1-bvec').blur();
  await expect(page.locator('#seriesRows input[type=checkbox]')).not.toBeChecked();
  await page.locator('#seriesRows input[type=checkbox]').check();
  const entries = await downloadDataset(page);
  expect(strFromU8(entries['sub-01/ses-01/dwi/sub-01_ses-01_dwi.bval'])).toBe('0\n');
});

test('an example download failure allows retry and the real example converts through download', async ({ page }) => {
  test.setTimeout(180000);
  const example = examples[0];
  // Refuse fetch before the shared cache lookup, including content-addressed
  // example assets supplied by an offline desktop host.
  await page.addInitScript(() => {
    window.failExample = true;
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (window.failExample && url.includes('1-001.dcm')) {
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return original(input, init);
    };
  });
  await page.goto('./');
  const picker = page.getByRole('combobox', { name: 'Input', exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'error');
  await page.evaluate(() => { window.failExample = false; });
  await picker.selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await reviewAnatomical(page);
  const entries = await downloadDataset(page);
  expect(entries['sub-01/ses-01/anat/sub-01_ses-01_T1w.nii.gz'].length).toBeGreaterThan(1000);
});

test('cancelling input conversion discards late outputs and permits retry', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishRead = () => {
          File.prototype.arrayBuffer = original;
          original.call(file).then(resolve, reject);
        };
      });
    };
  });
  const archive = zipSync(Object.fromEntries(dicomSeries().map(({ name, buffer }) => [name, buffer])));
  await page.locator('#imageInput').setInputFiles({ name: 'scanner.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) });
  await page.waitForFunction(() => typeof window.finishRead === 'function');
  await page.locator('#cancelButton').click();
  await page.evaluate(() => window.finishRead());
  await expect(page.locator('#statusText')).toHaveText('Operation cancelled');
  await expect(page.locator('#seriesRows tr')).toHaveCount(0);
  await page.locator('#retryButton').click();
  await expect(page.locator('#seriesRows tr')).toHaveCount(1, { timeout: 120000 });
});

test('automation requires explicit assignments and returns a downloadable BIDS artifact', async ({ page }) => {
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles(dicomSeries());
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch('adopt', { role: 'dicom' });
    await globalThis.neurodeskAutomation.dispatch('start', {
      parameters: { subject: '01', session: '01', privacy: 'omit', assignments: '[{"type":"T1w"}]' },
    });
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch('snapshot')).state), { timeout: 120000 }).toBe('succeeded');
  const pending = page.waitForEvent('download');
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('download', { artifactId: 'bids' }));
  const entries = unzipSync(readFileSync(await (await pending).path()));
  expect(entries['dataset_description.json']).toBeDefined();
});

test('public Philips enhanced DWI preserves native voxel and gradient ordering', async ({ page }) => {
  test.skip(!process.env.DCM2NIIX_DWI_DIR, 'Provision pinned data with node scripts/e2e-test-data.mjs dcm2niix.');
  test.setTimeout(180000);
  const directory = process.env.DCM2NIIX_DWI_DIR;
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(join(directory, 'IM_0001.dcm'));
  await reviewAnatomical(page, 'dwi');
  const entries = await downloadDataset(page);
  const base = Object.keys(entries).find(path => path.endsWith('_dwi.nii.gz')).replace(/\.nii\.gz$/, '');
  const expected = '701_DTI_Biobank_2mm_MB3S2_EPI_enh';
  const output = gunzipSync(entries[`${base}.nii.gz`]);
  const reference = readFileSync(join(directory, `${expected}.nii`));
  const header = new DataView(output.buffer, output.byteOffset, output.byteLength);
  expect(header.getInt16(48, true)).toBe(17);
  const offset = header.getFloat32(108, true);
  expect(Buffer.from(output.subarray(offset))).toEqual(reference.subarray(reference.readFloatLE(108)));
  const numbers = text => text.trim().split(/\s+/).map(Number);
  for (const extension of ['bval', 'bvec']) {
    const actual = numbers(strFromU8(entries[`${base}.${extension}`]));
    const native = numbers(readFileSync(join(directory, `${expected}.${extension}`), 'utf8'));
    expect(actual.length).toBe(native.length);
    actual.forEach((value, index) => expect(Math.abs(value - native[index])).toBeLessThan(0.00001));
  }
});

test('manual reverse phase encoding metadata links fmap to its forward DWI', async ({ page }) => {
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles([...dicomSeries({ series: 1 }), ...dicomSeries({ series: 2 })]);
  await expect(page.locator('#seriesRows tr')).toHaveCount(2);
  await page.locator('#subject').fill('01');
  await page.locator('#session').fill('01');
  await page.locator('#privacy').selectOption('omit');
  await page.locator('[data-series="series1"] select').selectOption('dwi');
  await page.locator('#series1-direction').fill('AP');
  await page.locator('#series1-PhaseEncodingDirection').selectOption('j');
  await page.locator('#series1-TotalReadoutTime').fill('0.05');
  await page.locator('#series1-gradients > summary').click();
  await page.locator('#series1-bval').fill('0');
  await page.locator('#series1-bvec').fill('0\n0\n0');
  await page.locator('[data-series="series2"] select').selectOption('epi');
  await page.locator('#series2-direction').fill('PA');
  await page.locator('#series2-PhaseEncodingDirection').selectOption('j-');
  await page.locator('#series2-TotalReadoutTime').fill('0.05');
  await page.locator('#series2-targets input[value="series1"]').check();
  await page.locator('[data-review="series1"]').check();
  await page.locator('[data-review="series2"]').check();
  const entries = await downloadDataset(page);
  const fieldmap = JSON.parse(strFromU8(entries['sub-01/ses-01/fmap/sub-01_ses-01_dir-PA_epi.json']));
  const target = JSON.parse(strFromU8(entries['sub-01/ses-01/dwi/sub-01_ses-01_dir-AP_dwi.json']));
  expect(fieldmap.IntendedFor).toEqual(['bids::sub-01/ses-01/dwi/sub-01_ses-01_dir-AP_dwi.nii.gz']);
  expect(target.B0FieldSource).toEqual([fieldmap.B0FieldIdentifier]);
});

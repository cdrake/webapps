import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readVolume } from '../../../packages/synthsr/src/volume.js';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
const source = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test('cancel terminates the worker and retry returns the actual native-grid defaced image', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  const workerCreated = page.waitForEvent('worker', { predicate: worker => /\/worker-[^/]+\.js$/.test(worker.url()) });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'allineate_hel' } });
  const worker = await workerCreated;
  const closed = new Promise(resolve => worker.once('close', resolve));
  await dispatch(page, 'cancel');
  await closed;
  const cancelled = await dispatch(page, 'snapshot');
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.report).toBeUndefined();
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface', parameters: { method: 'allineate' } });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 120000, intervals: [250, 1000, 2000] }).toBe('succeeded');
  const downloading = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'image' });
  const output = readVolume(source(await readFile(await (await downloading).path())));
  const input = readVolume(source(await readFile(fixture)));
  expect(output.dims).toEqual(input.dims);
  expect(output.affine).toEqual(input.affine);
  let removed = 0;
  let kept = 0;
  for (let index = 0; index < input.data.length; index++) {
    if (input.data[index] !== 0 && output.data[index] === 0) removed++;
    if (output.data[index] !== 0) {
      kept++;
      if (output.data[index] !== input.data[index]) throw new Error(`Unmasked voxel ${index} changed intensity`);
    }
  }
  expect(removed).toBeGreaterThan(100);
  expect(kept).toBeGreaterThan(100);
  expect((await dispatch(page, 'snapshot')).report.provenance.method).toBe('allineate');
});


test('an unsupported WebGPU adapter fails the operation with the app initialization error', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'deface' });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state).toBe('failed');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.error.message).toContain('initialize WebGPU');
  expect(snapshot.report).toBeUndefined();
  expect(await dispatch(page, 'viewers.list')).toEqual([]);
  await expect(page.locator('#applyBtn')).toBeDisabled();
  await expect(page.locator('#saveBtn')).toBeDisabled();
});

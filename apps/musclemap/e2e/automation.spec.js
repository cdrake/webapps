import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSyntheticMuscleMapNifti } from '../../../test/musclemap-full-pipeline-smoke.mjs';

const image = createSyntheticMuscleMapNifti();
const parameters = { model: 'musclemap-wholebody-v1.4', overlap: 0, chunkSize: '1', sourceChunkSize: '5', useWebGPU: false };

test('typed automation runs real muscle segmentation and metrics through the UI pipeline', async ({ page }) => {
  test.setTimeout(240000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  const contract = await page.evaluate(() => neurodeskAutomation.dispatch('describe'));
  expect(Object.keys(contract.operations)).toEqual(['segment']);
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'automation-muscle.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'images' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), parameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 180000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.images[0].sha256).toBe(createHash('sha256').update(image).digest('hex'));
  expect(snapshot.report.measurements[0].totalVolumeMl).toBeGreaterThan(0);
  expect(snapshot.report.provenance.segmentations[0].labelSpaceId).toBe('musclemap-wholebody-v1.4');
  for (const role of ['segmentation', 'metrics']) {
    const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, value]) => value.role === role);
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    const bytes = await readFile(await (await waiting).path());
    expect(bytes.length).toBe(artifact.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    if (role === 'metrics') expect(JSON.parse(bytes).totalVolumeMl).toBe(snapshot.report.measurements[0].totalVolumeMl);
  }
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'replacement.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'images' }));
  await page.evaluate(async parameters => {
    await neurodeskAutomation.dispatch('start', { operation: 'segment', parameters });
    await neurodeskAutomation.dispatch('cancel');
  }, parameters);
  const cancelled = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.report).toBeUndefined();
});

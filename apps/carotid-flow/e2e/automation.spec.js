import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test('typed detection measures the public phase-contrast example and exports matching curves and labels', async ({ page, request }) => {
  test.setTimeout(120000);
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  const hashes = {};
  for (const [index, role] of ['amplitude', 'phase'].entries()) {
    const response = await request.get(examples[0].files[index].url);
    expect(response.ok()).toBe(true);
    const buffer = await response.body();
    hashes[role] = createHash('sha256').update(buffer).digest('hex');
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name: `${role}.nii.gz`, mimeType: 'application/gzip', buffer });
    await dispatch(page, 'adopt', { role });
  }
  const started = await dispatch(page, 'start', { operation: 'detect-pair' });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 60000 }).not.toBe('running');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
  const { report, runId } = snapshot;
  expect(runId).toBe(started.runId);
  for (const role of ['amplitude', 'phase']) expect(report.inputs[role][0].sha256).toBe(hashes[role]);
  expect(report.measurements.method).toBe('velocity');
  expect(report.measurements.curveUnit).toBe('ml/min');
  expect(report.measurements.vessels.left.pixelCount).toBe(39);
  expect(report.measurements.vessels.right.pixelCount).toBe(34);
  expect(Math.round(report.measurements.vessels.left.mean)).toBe(231);
  expect(Math.round(report.measurements.vessels.right.mean)).toBe(211);
  for (const artifactId of ['labels', 'curves']) {
    const download = page.waitForEvent('download');
    await dispatch(page, 'download', { artifactId });
    const bytes = await readFile(await (await download).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(report.artifacts[artifactId].sha256);
    if (artifactId === 'curves') expect(bytes.toString().trim().split('\n')).toHaveLength(29);
  }
  const regions = await dispatch(page, 'viewers.regions', { viewerId: 'main' });
  expect(regions).toEqual(report.measurements.vessels);
  const state = await dispatch(page, 'viewers.tab', { viewerId: 'main', tabId: 'variability' });
  expect(state.tabs.find(tab => tab.id === 'variability').active).toBe(true);
});

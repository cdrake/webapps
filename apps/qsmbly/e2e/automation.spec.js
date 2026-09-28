import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';

const [example] = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));

test('typed QSM reconstruction runs the real brain example to a susceptibility download', async ({ page }) => {
  test.setTimeout(600000);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-qsmbly-automation');
  await mkdir(directory, { recursive: true });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  for (const role of ['magnitude', 'phase']) {
    const source = example.files.find(file => file.role === role);
    const path = join(directory, source.name);
    let bytes = await readFile(path).catch(() => null);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
      const response = await fetch(source.url);
      expect(response.ok).toBe(true);
      bytes = Buffer.from(await response.arrayBuffer());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
      await writeFile(path, bytes);
    }
    await page.locator('#neurodesk-input-transfer').setInputFiles(path);
    await page.evaluate(role => neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => neurodeskAutomation.dispatch('start', { operation: 'reconstruct', parameters: { echoTimesMs: [20], fieldStrength: 3 } }));
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.provenance.echoTimesMs).toEqual([20]);
  expect(snapshot.report.summary.susceptibility.unit).toBe('ppm');
  const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, artifact]) => artifact.role === 'qsm');
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const bytes = await readFile(await (await waiting).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  const volume = await readNifti(bytes);
  expect(volume.dims).toEqual([224, 224, 160]);
  expect(volume.data.every(Number.isFinite)).toBe(true);
  expect(volume.data.some(value => value !== 0)).toBe(true);
  await writeFile(join(directory, 'report.json'), JSON.stringify(snapshot.report, null, 2));
});

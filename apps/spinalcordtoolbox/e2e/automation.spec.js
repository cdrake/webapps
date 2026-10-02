import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha256 = '97638eee6df7c75b4de8921163e708420587de28b03eefb3fb1efbcdad659506';
const filename = 'sct_T2_spinalcord.nii.gz';
const parameters = { task: 'spinalcord' };

test('typed automation completes the real SCT T2 workflow and downloads its cord mask', async ({ page }) => {
  test.setTimeout(600000);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-sct-automation');
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    const response = await fetch(`https://huggingface.co/datasets/neurodeskorg/webapps/resolve/560955bf9a1a669bbf2a89709b64f3e64eefe008/examples/spinalcordtoolbox/t2-cord/${filename}`);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    await writeFile(path, bytes);
  }
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles(path);
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), parameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.image[0].sha256).toBe(sha256);
  const cord = snapshot.report.measurements.segmentation.labels.find(label => label.id === 1);
  expect(cord.voxels).toBeGreaterThan(0);
  expect(cord.volumeMl).toBeGreaterThan(0);
  expect(snapshot.report.provenance.executionProvider).toBe('wasm');
  const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, value]) => value.role === 'segmentation');
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const output = await readFile(await (await waiting).path());
  expect(output.length).toBe(artifact.bytes);
  expect(createHash('sha256').update(output).digest('hex')).toBe(artifact.sha256);
  await writeFile(join(directory, 'report.json'), JSON.stringify(snapshot.report, null, 2));
});

import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNiftiFromVolume, readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { decodeFcPack } from '../web/js/modules/fc-weighted-sum.js';

const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-calmar-automation');
const manifest = JSON.parse(await readFile(new URL('../web/models/manifest.json', import.meta.url)));
const lesionPath = new URL('../tests/fixtures/lnm-phantom/lesion-mni2.nii.gz', import.meta.url).pathname;

async function cachedAsset(url, name, checksum) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  let bytes = await readFile(path).catch(() => null);
  const matches = bytes && (!checksum || createHash('sha256').update(bytes).digest('hex') === checksum.replace(/^sha256:/, ''));
  if (!matches) {
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    if (checksum) expect(createHash('sha256').update(bytes).digest('hex')).toBe(checksum.replace(/^sha256:/, ''));
    await writeFile(path, bytes);
  }
  return bytes;
}

async function upload(page, role, input) {
  await page.locator('#neurodesk-input-transfer').setInputFiles(input);
  await page.evaluate(role => neurodeskAutomation.dispatch('adopt', { role }), role);
}

async function finish(page, operation, parameters = {}, timeout = 120000) {
  await page.evaluate(({ operation, parameters }) => neurodeskAutomation.dispatch('start', { operation, parameters }), { operation, parameters });
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout }).toMatch(/succeeded|failed/);
  return page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
}

async function download(page, report, role) {
  const [id, artifact] = Object.entries(report.artifacts).find(([, value]) => value.role === role);
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const bytes = await readFile(await (await waiting).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  return bytes;
}

test('supplied Visual lesion reproduces the real pinned connectivity channel', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await upload(page, 'lesion', lesionPath);
  const snapshot = await finish(page, 'map-lesion', { atlas: 'yeo7', minimumClusterSize: 0 });
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.measurements.directOverlap.totalLesionVoxels).toBe(64);
  expect(snapshot.report.measurements.directOverlap.networks[0].network).toBe('Visual');
  const output = await readNifti(await download(page, snapshot.report, 'networkMap'));
  const source = manifest.connectomeAssets.find(asset => asset.id === 'yeo7-fc-pack');
  const data = await cachedAsset(source.sourceUrl, 'yeo7-fc.bin', source.checksum);
  const index = JSON.parse(await cachedAsset(source.indexSourceUrl, 'yeo7-index.json'));
  const pack = decodeFcPack(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), index);
  let worst = 0;
  for (let voxel = 0; voxel < output.data.length; voxel++) worst = Math.max(worst, Math.abs(output.data[voxel] - pack.tMaps[0][voxel]));
  expect(worst).toBeLessThan(1e-6);
  const csv = (await download(page, snapshot.report, 'overlap')).toString();
  expect(csv).toContain('Visual');
  await download(page, snapshot.report, 'thresholdMask');
  await writeFile(join(directory, 'map-report.json'), JSON.stringify({ maximumVisualChannelError: worst, report: snapshot.report }, null, 2));
});

test('a matching shape with a shifted affine is rejected before lesion mapping', async ({ page }) => {
  const volume = await readNifti(await readFile(lesionPath));
  volume.header.affine[0][3] += 2;
  const bytes = Buffer.from(createNiftiFromVolume({ img: volume.data, hdr: { dims: volume.dims, pixDims: volume.header.pixDims, affine: volume.header.affine } }));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await upload(page, 'lesion', { name: 'shifted-lesion.nii', mimeType: 'application/x-nifti', buffer: bytes });
  const snapshot = await finish(page, 'map-lesion', { atlas: 'yeo7' });
  expect(snapshot.state).toBe('failed');
  expect(snapshot.error.message).toContain('dimensions and affine');
  expect(snapshot.report).toBeUndefined();
});

test('real structural example produces an unconfirmed native lesion candidate', async ({ page }) => {
  test.setTimeout(900000);
  const [example] = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));
  const source = example.files[0];
  const bytes = await cachedAsset(source.url, source.name, '725a37bf9556c6776a7be552597999df67d175a44eafc03252db058e8f5c5cad');
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await upload(page, 'structural', { name: source.name, mimeType: 'application/gzip', buffer: bytes });
  const snapshot = await finish(page, 'prepare-lesion', {}, 840000);
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.summary.requiresReview).toBe(true);
  expect(snapshot.report.summary.lesionConfirmed).toBe(false);
  expect(await page.evaluate(() => window.app.lesionMaskConfirmed)).toBe(false);
  const candidate = await readNifti(await download(page, snapshot.report, 'candidate'));
  expect(candidate.dims).toEqual((await readNifti(bytes)).dims);
  expect(candidate.data.every(value => value === 0 || value === 1)).toBe(true);
  await writeFile(join(directory, 'candidate-report.json'), JSON.stringify(snapshot.report, null, 2));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runNativeSynthseg } from '../src/native.js';
import { createNiftiFromData, createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io/nifti';

const options = { skip: process.platform === 'win32' ? 'The process fixture uses a POSIX executable script.' : false, timeout: 10000 };
const contract = {
  app: 'synthseg',
  appVersion: '0.3.20260924',
  artifacts: {
    labels: { type: 'neuro:label-map', mediaType: 'application/gzip', space: 'subject-1mm', labelSystem: 'FreeSurfer', selector: '#saveBtn' },
  },
};

async function setup(t, mode = 'success', { units = 2, slope = 1, labels = [0, 17, 17, 53, 53, 53, 1000, 1000] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'native-synthseg-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'synthseg fixture');
  await writeFile(binary, await readFile(new URL('./fixtures/native-synthseg.mjs', import.meta.url)), { mode: 0o755 });
  const input = join(directory, 'input ; $(not-a-command).nii');
  const header = createNiftiHeaderFromVolume({
    dims: [2, 2, 2],
    hdr: { affine: [[-2, 0.5, 0, 10], [0, 3, 0, -20], [0, 0, 4, 30], [0, 0, 0, 1]] },
  });
  new DataView(header).setUint8(123, units);
  const labelMap = createNiftiFromData(Int32Array.from(labels), header);
  new DataView(labelMap).setFloat32(112, slope, true);
  if (mode === 'invalid-nifti') new DataView(labelMap).setUint8(344, 0);
  if (mode === 'invalid-dimensions') new DataView(labelMap).setInt16(42, 32767, true);
  await writeFile(input, JSON.stringify({ mode, labels: Buffer.from(labelMap).toString('base64') }));
  return {
    contract,
    binary,
    outputDirectory: join(directory, 'output'),
    request: { inputs: { image: [input] }, parameters: { mode: 'fast', ct: true }, engine: 'native', timeoutMs: 5000 },
  };
}

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

test('native adapter passes literal argv and records actual sidecar provenance and file hashes', options, async t => {
  const args = await setup(t);
  const report = await runNativeSynthseg(args);
  const input = args.request.inputs.image[0];
  assert.deepEqual(JSON.parse(await readFile(`${input}.argv.json`, 'utf8')), [
    '--i', input, '--o', join(args.outputDirectory, 'labels.nii.gz'), '--quiet', '--fast', '--ct',
  ]);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.appVersion, contract.appVersion);
  assert.equal(report.provenance.version, 'fixture-build-4');
  assert.equal(report.provenance.executionProvider, 'metal');
  assert.equal(report.inputs.image.sha256, checksum(await readFile(input)));
  assert.equal(report.artifacts.labels.sha256, checksum(await readFile(join(args.outputDirectory, 'labels.nii.gz'))));
  assert.equal(report.artifacts.labels.labelSystem, 'FreeSurfer');
  assert.equal(report.artifacts.labels.selector, undefined);
  assert.equal(report.measurements.voxelVolumeMl, 0.024);
  assert.deepEqual(report.measurements.geometry.dimensions, [2, 2, 2]);
  assert.equal(report.measurements.geometry.spatialUnits, 'mm');
  assert.deepEqual(report.measurements.labels.find(label => label.id === 17), {
    id: 17, name: 'Left-Hippocampus', voxels: 2, volumeMl: 0.048,
  });
  assert.deepEqual(report.measurements.labels.find(label => label.id === 53), {
    id: 53, name: 'Right-Hippocampus', voxels: 3, volumeMl: 0.07200000000000001,
  });
  const savedBytes = await readFile(join(args.outputDirectory, 'report.json'));
  const savedReport = JSON.parse(savedBytes);
  assert.equal(savedReport.runId, report.runId);
  assert.deepEqual(savedReport.measurements, report.measurements);
  assert.equal(savedReport.artifacts.report, undefined);
  assert.equal(report.artifacts.report.sha256, checksum(savedBytes));
  assert.equal(report.artifacts.report.bytes, savedBytes.length);
});

test('native measurements convert explicit spatial units and omit unknowable volumes', options, async t => {
  for (const [units, factor] of [[1, 1e9], [3, 1e-9], [0, null]]) {
    const report = await runNativeSynthseg(await setup(t, 'success', { units }));
    const left = report.measurements.labels.find(label => label.id === 17);
    assert.equal(left.voxels, 2);
    if (factor === null) {
      assert.equal(report.measurements.voxelVolumeMl, null);
      assert.equal(left.volumeMl, undefined);
      assert.match(report.measurements.volumeUnavailable, /unknown spatial units/);
    } else {
      assert.ok(Math.abs(left.volumeMl - 0.048 * factor) <= 1e-12 * factor);
    }
  }
});

test('native reports reject invalid label images, dimensions and scaled label values', options, async t => {
  for (const mode of ['invalid-nifti', 'invalid-dimensions']) {
    const args = await setup(t, mode);
    await assert.rejects(runNativeSynthseg(args), /Native SynthSeg output/);
    await assert.rejects(readFile(join(args.outputDirectory, 'report.json')), { code: 'ENOENT' });
  }
  for (const options of [{ slope: 0.5 }, { labels: [0, 17, -1, 53, 53, 53, 1000, 1000] }]) {
    const args = await setup(t, 'success', options);
    await assert.rejects(runNativeSynthseg(args), /invalid label/);
    await assert.rejects(readFile(join(args.outputDirectory, 'report.json')), { code: 'ENOENT' });
  }
});

test('native adapter omits false CT and default-mode flags but requires an explicit CT choice', options, async t => {
  const args = await setup(t);
  args.request.parameters = { mode: 'default', ct: false };
  const report = await runNativeSynthseg(args);
  const argv = JSON.parse(await readFile(`${args.request.inputs.image[0]}.argv.json`, 'utf8'));
  assert.equal(argv.includes('--fast'), false);
  assert.equal(argv.includes('--ct'), false);
  assert.equal(report.provenance.ct, false);
  assert.equal(report.provenance.fast, false);
  const missingCt = await setup(t);
  delete missingCt.request.parameters.ct;
  await assert.rejects(runNativeSynthseg(missingCt), /requires an explicit ct parameter/);
  await assert.rejects(readFile(`${missingCt.request.inputs.image[0]}.argv.json`), { code: 'ENOENT' });
});

test('native adapter preserves existing outputs and rejects missing executables', options, async t => {
  const args = await setup(t);
  args.outputDirectory = join(args.binary, '..');
  await assert.rejects(runNativeSynthseg(args), /Output directory must be empty/);
  assert.equal(JSON.parse(await readFile(args.request.inputs.image[0], 'utf8')).mode, 'success');
  const missing = await setup(t);
  missing.binary += '-missing';
  await assert.rejects(runNativeSynthseg(missing), { code: 'ENOENT' });
  await assert.rejects(runNativeSynthseg({ ...missing, binary: '' }), /NEURODESK_SYNTHSEG_BIN/);
});

test('native adapter bounds process diagnostics and reports failing exit status', options, async t => {
  const args = await setup(t, 'fail');
  await assert.rejects(runNativeSynthseg(args), error => {
    assert.equal(error.code, 'NATIVE_EXIT');
    assert.match(error.message, /code 7/);
    assert.match(error.message, /fixture inference error/);
    assert.ok(Buffer.byteLength(error.message) < 66000);
    return true;
  });
  await assert.rejects(readFile(join(args.outputDirectory, 'report.json')), { code: 'ENOENT' });
});

test('native adapter rejects absent, empty, symbolic-link and invalid provenance outputs', options, async t => {
  for (const mode of ['missing', 'empty', 'symlink', 'symlink-report', 'invalid-json', 'wrong-parameters', 'missing-backend']) {
    const args = await setup(t, mode);
    await assert.rejects(runNativeSynthseg(args));
    await assert.rejects(readFile(join(args.outputDirectory, 'report.json')), { code: 'ENOENT' });
  }
});

test('native cancellation kills a process that ignores SIGTERM and leaves no successful report', options, async t => {
  const args = await setup(t, 'hang');
  const controller = new AbortController();
  const running = runNativeSynthseg({ ...args, signal: controller.signal });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  const started = Date.now();
  while (true) {
    try {
      await readFile(`${args.request.inputs.image[0]}.argv.json`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() - started > 3000) throw error;
      await delay(10);
    }
  }
  const aborted = Date.now();
  controller.abort();
  await rejected;
  assert.ok(Date.now() - aborted >= 200, 'the fixture must survive SIGTERM until the SIGKILL fallback');
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(readFile(join(args.outputDirectory, 'report.json')), { code: 'ENOENT' });
});

test('native timeout and cancellation before launch settle without successful reports', options, async t => {
  const args = await setup(t, 'hang');
  args.request.timeoutMs = 150;
  await assert.rejects(runNativeSynthseg(args), { name: 'TimeoutError' });
  const cancelled = await setup(t);
  await assert.rejects(runNativeSynthseg({ ...cancelled, signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readFile(`${cancelled.request.inputs.image[0]}.argv.json`), { code: 'ENOENT' });
});

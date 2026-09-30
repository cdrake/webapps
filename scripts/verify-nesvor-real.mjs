#!/usr/bin/env node
// Real scientific smoke gate. Simulator protocol tests cannot satisfy this gate.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createComputeClient } from '../packages/components/src/compute/index.js';
import { presetOptions } from '../apps/nesvor/src/spec.js';
import { readVolume } from '../packages/synthsr/src/volume.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

export function requireScientificBackend(info, expectedImage) {
  if (info?.simulated !== false || info.runner === 'simulate') throw new Error('Scientific validation refuses simulated or unspecified execution.');
  if (!info.gpu?.available) throw new Error('Scientific validation requires an available NVIDIA GPU.');
  if (info.runner !== 'docker') throw new Error('This release gate requires the digest-pinned Docker runner.');
  const tool = info.tools?.find(tool => tool.id === 'nesvor');
  if (tool?.version !== '0.5.0' || tool.image !== expectedImage) throw new Error('Backend NeSVoR version or container digest differs from the pinned release.');
}

export function validateScientificOutput(bytes, provenance, log, options) {
  const volume = readVolume(arrayBuffer(Buffer.from(bytes)));
  const spacing = [0, 1, 2].map(column => Math.hypot(...volume.affine.slice(0, 3).map(row => row[column])));
  if (spacing.some(value => Math.abs(value - options.outputResolution) > 1e-4)) throw new Error('Reconstruction voxel spacing does not match the requested isotropic resolution.');
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const dot = volume.affine.slice(0, 3).reduce((sum, row) => sum + row[i] * row[j], 0);
      if (Math.abs(dot) > 1e-4) throw new Error('Reconstruction affine contains unexpected shear.');
    }
  }
  let minimum = Infinity, maximum = -Infinity, sum = 0;
  for (const value of volume.data) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    sum += value;
  }
  if (!(maximum > minimum) || !(maximum > 0)) throw new Error('Reconstruction is empty or constant.');
  if (provenance?.simulated) throw new Error('Output provenance identifies a simulated result.');
  const required = {
    registration: options.registration, svort_version: 'v2', segmentation: true,
    bias_field_correction: true, n_iter: options.iterations,
    output_resolution: options.outputResolution, batch_size: options.batchSize,
    log2_hashmap_size: options.log2HashmapSize, single_precision: options.singlePrecision,
    weight_transformation: options.weightTransformation, weight_image: options.weightImage,
    n_samples: 256, n_levels_bias: 0, no_slice_scale: false,
    no_slice_variance: false, no_pixel_variance: false, no_transformation_optimization: false,
  };
  for (const [key, expected] of Object.entries(required)) {
    if (provenance?.[key] !== expected) throw new Error(`Upstream result.json has an unexpected or missing ${key}.`);
  }
  if (!Number.isInteger(provenance.device) || provenance.device < 0) throw new Error('Upstream provenance does not confirm CUDA execution.');
  for (const stage of ['Registration starts', 'NeSVoR training starts', 'Results saving starts']) {
    if (!log.includes(stage)) throw new Error(`Scientific log is missing ${stage}.`);
  }
  if (/\[ERROR\]|Traceback \(most recent call last\)/.test(log)) throw new Error('Scientific log contains an execution error.');
  return { dims: volume.dims, affine: volume.affine, spacingMm: spacing, extentMm: volume.dims.map((value, i) => value * spacing[i]), minimum, maximum, mean: sum / volume.data.length, voxels: volume.data.length };
}

export async function cachedAsset(entry, lock, cache, { fetch = globalThis.fetch, signal } = {}) {
  if (!lock || !/^[a-f0-9]{64}$/.test(lock.sha256) || !Number.isSafeInteger(lock.bytes)) throw new Error(`Example asset has no valid lock: ${entry.name}`);
  const path = join(cache, lock.sha256);
  try {
    const bytes = await readFile(path);
    if (bytes.length === lock.bytes && digest(bytes) === lock.sha256) return bytes;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(entry.url, { signal });
  if (!response.ok) throw new Error(`Example download failed for ${entry.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== lock.bytes || digest(bytes) !== lock.sha256) throw new Error(`Example checksum or byte count mismatch: ${entry.name}`);
  const temporary = `${path}.${randomUUID()}.partial`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
  return bytes;
}

export async function cleanupScientificJob(client, id) {
  const signal = AbortSignal.timeout(60000);
  await client.cancel(id, { signal });
  try { await client.watch(id, {}, { signal }); }
  catch (failure) { if (!['cancelled', 'tool-failed', 'interrupted'].includes(failure.code)) throw failure; }
  const terminal = await client.job(id, { signal });
  if (!['succeeded', 'failed', 'cancelled'].includes(terminal.status)) throw new Error(`Runner has not stopped: ${terminal.status}`);
  await client.remove(id, { signal });
}

export async function runScientificValidation({ baseUrl, credential, pairingCode, thicknesses, reportDirectory, cacheDirectory, signal, onProgress = () => {}, fetch = globalThis.fetch } = {}) {
  if (!baseUrl || !(credential || pairingCode)) throw new Error('Set NESVOR_BACKEND_URL and NESVOR_BACKEND_CREDENTIAL or NESVOR_PAIRING_CODE. This gate never skips missing infrastructure.');
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Backend credentials must not occur in a URL.');
  if (!Array.isArray(thicknesses) || ![1, 6].includes(thicknesses.length) || thicknesses.some(value => !Number.isFinite(value) || value <= 0 || value > 20)) throw new Error('Set NESVOR_EXAMPLE_THICKNESSES_MM to one or six confirmed physical thicknesses, in millimetres.');
  if (!reportDirectory || !cacheDirectory) throw new Error('Report and cache directories outside the repository are required.');
  for (const directory of [reportDirectory, cacheDirectory]) {
    await mkdir(directory, { recursive: true });
    const actual = await realpath(directory);
    const path = relative(await realpath(root), actual);
    if (!path.startsWith('..') && !path.startsWith('/')) throw new Error('Scientific reports, volumes and cached data must stay outside the source repository.');
  }
  if ((await readdir(reportDirectory)).length) throw new Error('Use a new empty report directory for each scientific validation run.');
  const examples = JSON.parse(await readFile(join(root, 'apps/nesvor/examples.json'), 'utf8'));
  const example = examples.find(example => example.id === 'svrtk-simulated-fetal');
  if (example.files.length !== 6 || example.files.some(file => file.role !== 'stack')) throw new Error('Expected the pinned six-stack example.');
  const lock = JSON.parse(await readFile(join(root, 'registry/offline-assets.lock.json'), 'utf8'));
  const expectedImage = JSON.parse(await readFile(join(root, 'registry/neurocontainers.json'), 'utf8')).containers.nesvor.image;
  const client = createComputeClient({ baseUrl, token: credential, fetch });
  if (!credential) await client.pair(pairingCode, { signal });
  const info = await client.info({ signal });
  requireScientificBackend(info, expectedImage);
  const files = {}, stacks = [], inputs = [];
  for (let i = 0; i < example.files.length; i++) {
    signal?.throwIfAborted();
    const entry = example.files[i];
    const pinned = lock.assets[entry.url];
    const bytes = await cachedAsset(entry, pinned, cacheDirectory, { fetch, signal });
    readVolume(arrayBuffer(bytes));
    const file = `stack-${i}`;
    const thickness = thicknesses.length === 1 ? thicknesses[0] : thicknesses[i];
    files[file] = new Blob([bytes]);
    stacks.push({ file, thickness });
    inputs.push({ name: entry.name, url: entry.url, sha256: pinned.sha256, bytes: pinned.bytes, thicknessMm: thickness });
  }
  const options = presetOptions('fetal-brain');
  const startedAt = new Date().toISOString();
  const idempotencyKey = randomUUID();
  await writeFile(join(reportDirectory, 'submission.json'), `${JSON.stringify({ idempotencyKey, baseUrl: client.baseUrl, startedAt, inputs, options }, null, 2)}\n`);
  const job = await client.submit({ tool: 'nesvor', command: 'reconstruct', stacks, options }, files, { signal, idempotencyKey });
  await writeFile(join(reportDirectory, 'receipt.json'), `${JSON.stringify(job, null, 2)}\n`);
  try {
    const done = await client.watch(job.id, { onProgress }, { signal });
    if (done.status !== 'succeeded' || done.simulated !== false) throw new Error('Real reconstruction did not succeed or was marked simulated.');
    const [volume, result, logs] = await Promise.all(['volume.nii.gz', 'result.json', 'log.txt'].map(name => client.output(job.id, name, { signal })));
    const bytes = Buffer.from(await volume.arrayBuffer());
    const provenance = JSON.parse(await result.text());
    const log = await logs.text();
    const metrics = validateScientificOutput(bytes, provenance, log, options);
    const report = { schemaVersion: 1, validation: 'real-neural-reconstruction-smoke', passed: true, parityEstablished: false, startedAt, finishedAt: new Date().toISOString(), jobId: job.id, serverVersion: info.version, runner: info.runner, gpu: info.gpu, upstreamVersion: '0.5.0', image: expectedImage, example: example.id, inputs, options, output: { sha256: digest(bytes), bytes: bytes.length, ...metrics }, provenance, logSha256: digest(log) };
    await writeFile(join(reportDirectory, 'volume.nii.gz'), bytes);
    await writeFile(join(reportDirectory, 'result.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await writeFile(join(reportDirectory, 'log.txt'), log);
    await writeFile(join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    let cleanupError = null;
    try {
      await cleanupScientificJob(client, job.id);
    } catch (failure) { cleanupError = failure.message; }
    await writeFile(join(reportDirectory, 'failure.json'), `${JSON.stringify({ passed: false, jobId: job.id, error: error.message, cleanupError }, null, 2)}\n`);
    if (cleanupError) throw new Error(`${error.message} Cleanup also failed: ${cleanupError}. Inspect job ${job.id} on the backend.`);
    throw error;
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const temporary = process.env.TMPDIR;
    if (!temporary) throw new Error('Set TMPDIR to a storage-volume directory for the pinned example cache.');
    const reportDirectory = process.env.NESVOR_REPORT_DIR;
    const report = await runScientificValidation({ baseUrl: process.env.NESVOR_BACKEND_URL, credential: process.env.NESVOR_BACKEND_CREDENTIAL, pairingCode: process.env.NESVOR_PAIRING_CODE, thicknesses: (process.env.NESVOR_EXAMPLE_THICKNESSES_MM || '').split(',').map(Number), reportDirectory, cacheDirectory: join(temporary, 'nesvor-real-example-cache'), signal: AbortSignal.timeout(4 * 60 * 60 * 1000), onProgress: event => console.log(`${event.stage}: ${event.fraction ?? ''}`) });
    console.log(`Real NeSVoR smoke validation passed: ${report.jobId}. Report: ${join(reportDirectory, 'report.json')}. Numerical parity is not established by this check.`);
  } catch (error) {
    console.error(`NeSVoR scientific validation FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

/*
 * Node runtime for the sct-webapp command line: pinned, checksum-verified models
 * on disk, ONNX Runtime's native CPU backend and the web app's output files.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import packageJson from '../package.json' with { type: 'json' };
import { prepareInput, segmentPrepared } from './segment.js';
import { DEFAULT_TASK_ID, getTask, modelAsset, resultFileName, runSettings, runnableTasks } from './tasks.js';

// Native ORT must see this before loading.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const ort = await import('onnxruntime-node');

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

// Packaging installs the default task's model next to the launcher; every other task is downloaded on request.
export const BUNDLED_TASKS = Object.freeze([DEFAULT_TASK_ID]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

/** Models the user downloads: --cache-dir, else the user cache. */
export function defaultCacheDir() {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'sct-webapp');
}

/** Read-only models installed with a portable release (set by its launcher). */
function bundledModelDir() {
  return process.env.NEURODESK_SCT_WEBAPP_MODEL_DIR || null;
}

function modelDirectories(cacheDir) {
  return [bundledModelDir(), cacheDir].filter(Boolean);
}

function sizeText(bytes) {
  return `${Math.round(bytes / 1048576)} MB`;
}

/** The verified bytes of an installed model, or null when no directory has it. */
async function readInstalledModel(asset, directories) {
  for (const directory of directories) {
    const path = join(directory, asset.filename);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) {
      throw new Error(`${path} failed SHA-256 verification. Delete it and run "sct-webapp download-models --task ${asset.taskId}".`);
    }
    return { path, bytes };
  }
  return null;
}

async function isInstalled(asset, directories) {
  for (const directory of directories) {
    const found = await stat(join(directory, asset.filename)).catch(() => null);
    if (found?.isFile()) return true;
  }
  return false;
}

async function download(asset, cacheDir, onProgress) {
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, asset.filename);
  const partial = `${path}.${randomUUID()}.partial`;
  onProgress(`Downloading ${asset.filename} (${sizeText(asset.bytes)}) for ${asset.taskId}`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Download ${asset.filename}: HTTP ${response.status}`);
  const hash = createHash('sha256');
  let received = 0;
  let reported = 0;
  const counted = Readable.fromWeb(response.body).map((chunk) => {
    hash.update(chunk);
    received += chunk.length;
    if (received > asset.bytes) throw new Error(`${asset.filename} is larger than its pinned ${asset.bytes} bytes`);
    const tenth = Math.floor((received / asset.bytes) * 10);
    if (tenth > reported) {
      reported = tenth;
      onProgress(`${asset.filename}: ${tenth * 10}%`);
    }
    return chunk;
  });
  try {
    await pipeline(counted, createWriteStream(partial, { flags: 'wx' }));
    if (received !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw new Error(`${asset.filename} download failed SHA-256 verification`);
    }
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return path;
}

/**
 * Install the models of the given tasks (default: the bundled set) into cacheDir.
 * Models already present and verified are kept.
 */
export async function downloadModels({ tasks = BUNDLED_TASKS, cacheDir = defaultCacheDir(), onProgress = () => {} } = {}) {
  const installed = [];
  for (const taskId of tasks) {
    const asset = modelAsset(getTask(taskId));
    const existing = await readInstalledModel(asset, modelDirectories(cacheDir));
    const path = existing?.path ?? await download(asset, cacheDir, onProgress);
    installed.push({ task: taskId, filename: asset.filename, sha256: asset.sha256, path: resolve(path) });
  }
  return { directory: resolve(cacheDir), models: installed };
}

async function loadModel(asset, { cacheDir, offline, onProgress }) {
  const installed = await readInstalledModel(asset, modelDirectories(cacheDir));
  if (installed) return installed;
  if (offline) {
    throw new Error(`The ${asset.taskId} model (${asset.filename}, ${sizeText(asset.bytes)}) is not installed. Run "sct-webapp download-models --task ${asset.taskId}" once while online.`);
  }
  await download(asset, cacheDir, onProgress);
  return readInstalledModel(asset, [cacheDir]);
}

/** Which task models are present, without reading the large files. */
export async function listTasks({ cacheDir = defaultCacheDir() } = {}) {
  const directories = modelDirectories(cacheDir);
  const tasks = [];
  for (const task of runnableTasks()) {
    const asset = modelAsset(task);
    tasks.push({
      task: task.id,
      name: task.displayName,
      model: asset.filename,
      bytes: asset.bytes,
      installed: await isInstalled(asset, directories),
    });
  }
  return tasks;
}

export async function checkInstallation({ cacheDir = defaultCacheDir() } = {}) {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const input = new ort.Tensor('float32', Float32Array.of(42), [1]);
  try {
    const { y } = await session.run({ x: input });
    if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  } finally {
    input.dispose();
    await session.release();
  }
  const bundled = bundledModelDir();
  if (bundled) {
    for (const taskId of BUNDLED_TASKS) {
      const asset = modelAsset(getTask(taskId));
      if (!await readInstalledModel(asset, [bundled])) throw new Error(`The bundled ${taskId} model is missing from ${bundled}.`);
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    version: packageJson.version,
    tasks: await listTasks({ cacheDir }),
  };
}

export function resolveThreads(value = Math.min(4, availableParallelism())) {
  const threads = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 256) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

function maskVoxels(niftiData) {
  const bytes = new Uint8Array(niftiData);
  const offset = Math.ceil(new DataView(niftiData).getFloat32(108, true));
  let voxels = 0;
  for (let index = offset; index < bytes.length; index++) voxels += bytes[index] > 0;
  return voxels;
}

/**
 * Segment one NIfTI image with an SCT task and write the web app's downloads:
 * <task>_<stage>.nii for every mask and <task>_lesion_metrics.csv when the task
 * measures lesions.
 */
export async function segment({
  input,
  output,
  task: taskId = DEFAULT_TASK_ID,
  threshold,
  minimumComponentSize,
  testTimeAugmentation = false,
  threads = resolveThreads(),
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  if (!input || !output) throw new Error('Provide an input image and an output directory.');
  const task = getTask(taskId);
  const settings = runSettings(task, { threshold, minimumComponentSize, testTimeAugmentation });
  const asset = modelAsset(task);
  await assertNewOutput(output);
  const inputBytes = await readFile(input);
  const inputData = inputBytes.buffer.slice(inputBytes.byteOffset, inputBytes.byteOffset + inputBytes.byteLength);
  const events = {
    log: onLog,
    analysis: (message) => onProgress(message),
    progress: () => {},
  };
  // Refuse an unreadable image before loading a model.
  const prepared = prepareInput(inputData, { decompress: gunzipSync, events });
  const model = await loadModel(asset, { cacheDir, offline, onProgress });
  onLog(`Loaded: ${asset.filename} (${(model.bytes.length / 1048576).toFixed(1)} MB) from ${model.path}`);
  const session = await ort.InferenceSession.create(model.bytes, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
  });
  const { results } = await segmentPrepared(prepared, settings, { ort, session, events });

  await mkdir(output, { recursive: true });
  const files = [];
  const measurements = {};
  for (const result of results) {
    if (result.kind === 'metrics') {
      await writeFile(join(output, result.filename), result.csv, { flag: 'wx' });
      files.push(result.filename);
      measurements[result.stage] = result.summary;
    } else {
      const name = resultFileName(task.id, result.stage);
      await writeFile(join(output, name), new Uint8Array(result.niftiData), { flag: 'wx' });
      files.push(name);
      measurements[result.stage] = { voxels: maskVoxels(result.niftiData) };
    }
  }
  return {
    input: basename(input),
    output: resolve(output),
    task: task.id,
    files,
    measurements,
    provenance: {
      appVersion: packageJson.version,
      task: task.id,
      model: asset.filename,
      modelUrl: asset.url,
      modelSha256: asset.sha256,
      sourceVersion: asset.sourceVersion,
      executionProvider: 'cpu',
      onnxRuntime: ort.env.versions.node,
      threads,
      settings: {
        threshold: settings.threshold,
        minComponentSize: settings.minComponentSize,
        overlap: settings.overlap,
        keepLargestComponent: settings.keepLargestComponent,
        testTimeAugmentation: settings.testTimeAugmentation,
        patchSize: settings.patchSize,
      },
    },
  };
}

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import manifest from '../model.manifest.json' with { type: 'json' };
import qsmxt from '../qsmxt.json' with { type: 'json' };

export const MODEL_ASSETS = Object.freeze(manifest.assets);
export const QSMXT = qsmxt;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Model weights are not part of the release. They download on first use into the user's cache;
// the launcher's NEURODESK_OFFLINE marks releases that bundle their models, so it does not apply here.
const offlineByDefault = () => process.env.QSMBLY_OFFLINE === '1';

export function releasePlatform(platform = process.platform, arch = process.arch) {
  const id = { 'linux-x64': 'linux-x64', 'win32-x64': 'windows-x64', 'darwin-arm64': 'macos-arm64' }[`${platform}-${arch}`];
  if (!id) throw new Error(`QSMxT ${qsmxt.version} is not packaged for ${platform}-${arch}.`);
  return id;
}

export const nativeDirectory = () => join(PACKAGE_ROOT, 'native');

export function qsmxtExecutable(platform = releasePlatform()) {
  return join(nativeDirectory(), qsmxt.targets[platform].executables[0]);
}

export function defaultCacheDir() {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'qsmbly', 'models');
}

// The release's models/ directory (set by the launcher) is read first, so an offline model pack
// copied there is used; downloads go to the user cache, which is writable on every platform.
export function modelDirectories({ cacheDir = defaultCacheDir() } = {}) {
  const bundled = process.env.NEURODESK_QSMBLY_MODEL_DIR;
  return { search: [...new Set([bundled, cacheDir].filter(Boolean))], cacheDir };
}

// Implicit model use: segmentation runs SynthSeg, and chi-separation falls back to R2PRIMEnet
// when no MESE acquisition supplies R2'.
const IMPLICIT = Object.freeze({
  '--do-segmentation': ['synthseg'],
  '--do-analysis': ['synthseg'],
  segment: ['synthseg'],
  '--do-chisep': ['r2primenet'],
  '--do-r2primemap': ['r2primenet'],
  r2prime: ['r2primenet'],
});

/**
 * The weight files a QSMxT command line names: algorithm and mask-op values (`xqsm`,
 * `hd-bet:128x128x128`), flags that imply a model, and the same names in a `--config` file.
 */
export async function modelsNamedBy(args, { readText = (path) => readFile(path, 'utf8') } = {}) {
  const texts = [...args];
  for (let index = 0; index < args.length; index++) {
    const value = args[index] === '--config' ? args[index + 1] : args[index].startsWith('--config=') ? args[index].slice(9) : null;
    if (value) texts.push(await readText(value));
  }
  const ids = new Set();
  for (const text of texts) {
    for (const token of text.toLowerCase().split(/[^a-z0-9+-]+/)) {
      for (const id of IMPLICIT[token] ?? []) ids.add(id);
      if (MODEL_ASSETS.some((asset) => asset.model === token)) ids.add(token);
    }
  }
  return MODEL_ASSETS.filter((asset) => ids.has(asset.model));
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function findVerified(asset, search) {
  for (const directory of search) {
    const path = join(directory, asset.filename);
    const info = await stat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (info && info.size === asset.bytes && (await fileSha256(path)) === asset.sha256) return path;
  }
  return null;
}

async function download(asset, cacheDir, onProgress) {
  onProgress(`Downloading ${asset.filename} (${Math.round(asset.bytes / 1e6)} MB)…`);
  const response = await fetch(asset.url);
  if (!response.ok || !response.body) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, asset.filename);
  const partial = `${path}.${randomUUID()}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(partial, { flags: 'wx' }));
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw new Error(`${asset.filename} download failed checksum verification.`);
    }
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return path;
}

/** Make every asset available, verified by size and SHA-256, downloading only what is missing. */
export async function ensureModels(assets, { cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  const { search } = modelDirectories({ cacheDir });
  const paths = [];
  for (const asset of assets) {
    let path = await findVerified(asset, search);
    if (!path) {
      if (offline) {
        throw new Error(`${asset.filename} (${asset.model}) is not in ${search.join(' or ')}. Run "qsmbly download-models" while online, or copy the model pack there.`);
      }
      path = await download(asset, cacheDir, onProgress);
    }
    paths.push(path);
  }
  return paths;
}

export async function downloadModels({ models, cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  const unknown = (models ?? []).filter((id) => !MODEL_ASSETS.some((asset) => asset.model === id));
  if (unknown.length) throw new Error(`Unknown model ${unknown.join(', ')}. Models: ${[...new Set(MODEL_ASSETS.map((asset) => asset.model))].join(', ')}.`);
  const assets = models?.length ? MODEL_ASSETS.filter((asset) => models.includes(asset.model)) : MODEL_ASSETS;
  await ensureModels(assets, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: assets.length, bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0) };
}

// QSM_MODEL_DIR and QSM_MODEL_CACHE are the two places qsm-core looks for weights before it
// downloads; pointing both at verified directories keeps QSMxT on the pinned files.
export function qsmxtEnvironment({ cacheDir = defaultCacheDir(), environment = process.env } = {}) {
  const { search } = modelDirectories({ cacheDir });
  return { ...environment, QSM_MODEL_DIR: search[0], QSM_MODEL_CACHE: cacheDir };
}

export function qsmxtVersion(executable = qsmxtExecutable()) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot start QSMxT at ${executable}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`QSMxT --version failed: ${result.stderr}`);
  const version = /^qsmxt (\S+)$/m.exec(result.stdout)?.[1];
  const core = /^qsm-core: (\S+)/m.exec(result.stdout)?.[1];
  const deepLearning = /^deep-learning models: (\S+)$/m.exec(result.stdout)?.[1];
  return { version, qsmCore: core, deepLearning: deepLearning === 'enabled' };
}

export async function checkInstallation() {
  const executable = qsmxtExecutable();
  const native = qsmxtVersion(executable);
  if (native.version !== qsmxt.version || native.qsmCore !== qsmxt.qsmCore || !native.deepLearning) {
    throw new Error(`Expected QSMxT ${qsmxt.version} with qsm-core ${qsmxt.qsmCore} and deep learning, found ${JSON.stringify(native)}.`);
  }
  const { search, cacheDir } = modelDirectories();
  return {
    executable: process.execPath,
    node: process.version,
    onnxRuntime: null,
    qsmxt: { ...native, executable },
    models: { search, cacheDir, available: MODEL_ASSETS.length },
  };
}

/** Run QSMxT with the given arguments after fetching the weights they name; resolves to its exit code. */
export async function runQsmxt(args, { onProgress = () => {}, offline = offlineByDefault() } = {}) {
  const cacheDir = defaultCacheDir();
  await ensureModels(await modelsNamedBy(args), { cacheDir, offline, onProgress });
  const child = spawn(qsmxtExecutable(), args, { stdio: 'inherit', env: qsmxtEnvironment({ cacheDir }) });
  // The terminal delivers Ctrl-C to QSMxT as well; wait for it to stop rather than leaving it running.
  const ignore = () => {};
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, ignore);
  try {
    return await new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolvePromise(code ?? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1)));
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, ignore);
  }
}

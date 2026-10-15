// Stage this host's pinned QSMxT release archive in native/, after checking its SHA-256.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EXAMPLE_ASSETS, MODEL_ASSETS, QSMXT, nativeDirectory, qsmxtVersion, releasePlatform } from '../src/node.js';
import { verifyNativeExamples, verifyNativeWeights } from '../src/native-registry.js';

const platform = process.argv[2] ?? releasePlatform();
const target = QSMXT.targets[platform];
if (!target) throw new Error(`No pinned QSMxT archive for ${platform}`);
async function pinnedSource(pin) {
  const response = await fetch(pin.url);
  if (!response.ok) throw new Error(`Failed to read the pinned native registry: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
    throw new Error('The native registry failed checksum verification.');
  }
  return bytes.toString('utf8');
}
const [models, examples] = await Promise.all([QSMXT.modelRegistry, QSMXT.exampleRegistry].map(pinnedSource));
verifyNativeWeights(models, MODEL_ASSETS, QSMXT.weightFiles);
verifyNativeExamples(examples, EXAMPLE_ASSETS);
const directory = nativeDirectory();
const stamp = join(directory, 'archive.sha256');

const current = await readFile(stamp, 'utf8').catch(() => '');
const complete = await Promise.all([...target.executables, ...target.files].map((name) => access(join(directory, name)).then(() => true, () => false)));
if (current.trim() === target.sha256 && complete.every(Boolean)) {
  console.log(`QSMxT ${QSMXT.version} for ${platform} already staged in ${directory}`);
} else {
  const response = await fetch(target.url);
  if (!response.ok) throw new Error(`Failed to download ${target.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== target.sha256) throw new Error(`${basename(target.url)} has SHA-256 ${digest}, expected ${target.sha256}`);
  await mkdir(join(directory, '..'), { recursive: true });
  const work = await mkdtemp(join(directory, '..', '.native-'));
  try {
    const archive = join(work, basename(target.url));
    await writeFile(archive, bytes);
    const extracted = join(work, 'extracted');
    await mkdir(extracted);
    // Windows' own bsdtar reads the zip; Git for Windows puts a GNU tar, which cannot, first on PATH.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const result = spawnSync(tar, ['-xf', archive, '-C', extracted], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`tar could not extract ${archive}: ${result.stderr}`);
    const names = (await readdir(extracted)).sort();
    const expected = [...target.executables, ...target.files].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`${basename(target.url)} contains ${names.join(', ')}, expected ${expected.join(', ')}`);
    for (const name of target.executables) await chmod(join(extracted, name), 0o755);
    await writeFile(join(extracted, 'archive.sha256'), `${target.sha256}\n`);
    await rm(directory, { recursive: true, force: true });
    await rename(extracted, directory);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(`Staged QSMxT ${QSMXT.version} for ${platform} in ${directory}`);
}

if (platform === releasePlatform()) {
  const native = qsmxtVersion();
  if (native.version !== QSMXT.version || native.qsmCore !== QSMXT.qsmCore || !native.deepLearning) {
    throw new Error(`Staged QSMxT reports ${JSON.stringify(native)}`);
  }
}

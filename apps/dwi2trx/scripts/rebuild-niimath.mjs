// Rebuild the shared dtifit runtime from a pinned source and SDK into --output.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const sourceCommit = 'cc26582a250c411b5c3c3c05c91dfd58f66be089';
const sdkCommit = '35659964bc2762fffec0d257997fb61475f765b7';
const sdkVersion = '6.0.13';
const releaseHash = 'eb132757325583b787fe9414b09afea9442b72ad';
const zlibVersion = '1.3.2';
const { values } = parseArgs({ options: {
  source: { type: 'string' },
  emsdk: { type: 'string' },
  output: { type: 'string' },
} });
if (!values.source || !values.emsdk || !values.output) {
  throw new Error('Usage: node rebuild-niimath.mjs --source <niimath checkout> --emsdk <SDK checkout> --output <directory>');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const source = resolve(values.source);
const sdk = resolve(values.emsdk);
const output = resolve(values.output);
for (const [directory, expected] of [[source, sourceCommit], [sdk, sdkCommit]]) {
  if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }) !== expected) {
    throw new Error(`${directory} must be at ${expected}.`);
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: directory })) {
    throw new Error(`${directory} has modified tracked sources.`);
  }
}

const emcc = join(sdk, 'upstream/emscripten/emcc');
const cache = join(sdk, 'upstream/emscripten/cache');
const env = { ...process.env, EM_CONFIG: join(sdk, '.emscripten'), EM_CACHE: cache };
const compiler = run(emcc, ['--version'], { env });
if (!compiler.split('\n')[0].includes(` ${sdkVersion} `)) {
  throw new Error(`Expected Emscripten ${sdkVersion}: ${compiler.split('\n')[0]}`);
}

const sources = ['niimath.c', 'core.c', 'core32.c', 'nifti_io.c', 'unifize.c', 'bwlabel.c', 'tensor.c', 'dtifit.c'];
const flags = [
  '-O3', '-DEMSCRIPTEN', '-DFORCE_INT32_MAX', '-DFSLSTYLE', '-DPIGZ', '-DREJECT_COMPLEX',
  '-DHAVE_TENSOR', '-DHAVE_DTIFIT', '-DHAVE_ZLIB', '-sUSE_ZLIB=1',
  '-sSTACK_SIZE=4194304', '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=2147483648',
  '-sEXPORT_ES6=1', '-sMODULARIZE=1', '-sINVOKE_RUN=0',
  '-sEXPORTED_FUNCTIONS=["_main","_malloc","_free"]',
  '-sEXPORTED_RUNTIME_METHODS=["callMain","ccall","cwrap","FS","ENV","FS_createDataFile","FS_readFile","FS_unlink","getValue","stringToUTF8","setValue"]',
];

const work = await mkdtemp(join(tmpdir(), 'dwi2trx-niimath-'));
try {
  run('git', ['clone', '--quiet', '--shared', source, join(work, 'source')]);
  const cwd = join(work, 'source/src');
  run(emcc, [...flags, ...sources, '-lm', '-o', join(work, 'niimath.js')], { cwd, env });
  // The same two post-processing steps as the pinned upstream js/scripts/pre-build.ts.
  let glue = await readFile(join(work, 'niimath.js'), 'utf8');
  glue = glue.replace(/args=\[\]/g, 'args');
  glue = glue.replace(
    /function getMemoryBuffer\(\)\{try\{var b=wasmMemory\.toResizableBuffer\(\);return b\}catch\{\}return wasmMemory\.buffer\}/g,
    'function getMemoryBuffer(){return wasmMemory.buffer}',
  );
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'niimath.js'), glue);
  await writeFile(join(output, 'niimath.wasm'), await readFile(join(work, 'niimath.wasm')));
  const files = {};
  for (const name of ['niimath.js', 'niimath.wasm']) {
    const bytes = await readFile(join(output, name));
    files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  await writeFile(join(output, 'provenance.json'), `${JSON.stringify({
    source: { repository: 'https://github.com/rordenlab/niimath', commit: sourceCommit },
    sdk: { repository: 'https://github.com/emscripten-core/emsdk', commit: sdkCommit, version: sdkVersion, releaseHash },
    compiler, zlibVersion, sources, flags, files,
  }, null, 2)}\n`);
  await writeFile(join(output, 'LICENSE'), await readFile(join(source, 'LICENSE')));
  const labels = await readFile(join(source, 'src/bwlabel.c'), 'utf8');
  const labelLicense = labels.slice(labels.indexOf('//Copyright 2021 Jesper Andersson'), labels.indexOf('//for usage'))
    .replace(/^\/\//gm, '');
  const emscriptenLicense = await readFile(join(sdk, 'upstream/emscripten/LICENSE'), 'utf8');
  const zlibLicense = await readFile(join(cache, `ports/zlib/zlib-${zlibVersion}/LICENSE`), 'utf8');
  await writeFile(join(output, 'NOTICE'), [
    `niimath ${sourceCommit}; see LICENSE for its BSD-2-Clause notice.`,
    'The AFNI tensor and unifize routines are public-domain works of the US NIH.',
    labelLicense, zlibLicense, emscriptenLicense,
  ].join('\n\n'));
  console.log(JSON.stringify({ output, files }, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}

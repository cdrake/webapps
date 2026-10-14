import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import appManifest from '../../../models/qsmbly.manifest.json' with { type: 'json' };
import { MODEL_ASSETS, QSMXT, ensureModels, ensureNativeModelDirectory, modelsNamedBy, nativeModelAssets, qsmxtEnvironment } from '../src/node.js';
import { verifyNativeWeights } from '../src/native-registry.js';

const bin = new URL('../bin/qsmbly.js', import.meta.url).pathname;
const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const named = async (args, files = {}) => (await modelsNamedBy(args, { readText: async (path) => files[path] })).map((asset) => asset.filename);

test('the CLI pins the same weights as the web app wherever both list a file', () => {
  const app = new Map(appManifest.assets.map((asset) => [asset.filename, asset]));
  let shared = 0;
  for (const asset of MODEL_ASSETS) {
    assert.match(asset.url, /^https:\/\/huggingface\.co\/qsmxt\/qsm-onnx-weights\/resolve\/[0-9a-f]{40}\//);
    assert.ok(asset.url.endsWith(`/${asset.filename}`));
    const web = app.get(asset.filename);
    if (!web) continue;
    shared += 1;
    assert.deepEqual([asset.url, asset.sha256, asset.bytes], [web.url, web.sha256, web.bytes], asset.filename);
  }
  assert.ok(shared >= 10, 'the app and CLI share the inversion and HD-BET weights');
});

test('QSMxT is pinned to the release built on the qsm-core tag the web app compiles', async () => {
  const cargo = await readFile(new URL('../../../apps/qsmbly/rust-wasm/Cargo.toml', import.meta.url), 'utf8');
  assert.match(cargo, new RegExp(`qsm-core = \\{ git = "https://github.com/astewartau/QSM.rs.git", tag = "${QSMXT.qsmCore}" \\}`));
  assert.match(cargo, new RegExp(`qsmxt-config = \\{ git = "https://github.com/QSMxT/QSMxT.git", tag = "v${QSMXT.version}" \\}`));
  assert.deepEqual(Object.keys(QSMXT.targets).sort(), ['linux-x64', 'macos-arm64', 'windows-x64']);
  const release = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'));
  for (const [platform, target] of Object.entries(QSMXT.targets)) {
    assert.ok(target.url.startsWith(`https://github.com/QSMxT/QSMxT/releases/download/v${QSMXT.version}/qsmxt-v${QSMXT.version}-`), platform);
    assert.match(target.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(release.targets[platform].native, target.executables.map((name) => `app/native/${name}`), platform);
  }
  // The glibc build needs glibc 2.39; the static musl build runs on every x64 Linux.
  assert.match(QSMXT.targets['linux-x64'].url, /x86_64-unknown-linux-musl/);
  assert.equal(release.bundleModels, false);
});

test('a command fetches only the weights it names', async () => {
  assert.deepEqual(await named(['run', 'bids', 'out', '--qsm-algorithm', 'rts', '--mask', 'phase-quality,threshold:otsu']), []);
  assert.deepEqual(await named(['run', 'bids', '--qsm-algorithm', 'xqsm']), ['xqsm.onnx']);
  assert.deepEqual(await named(['run', 'bids', '--qsm-algorithm=qsmnet-plus']), ['qsmnet-plus.onnx']);
  assert.deepEqual(await named(['run', 'bids', '--mask', 'hd-bet:128x128x128:tta']), ['hd-bet.onnx']);
  assert.deepEqual(await named(['run', 'bids', '--qsm-algorithm', 'nextqsm']), ['nextqsm-bf.onnx', 'nextqsm-vjp.onnx']);
  assert.deepEqual(await named(['run', 'bids', '--do-analysis']), ['synthseg.onnx']);
  assert.deepEqual(await named(['run', 'bids', '--do-chisep']), ['r2primenet.onnx']);
  assert.deepEqual(await named(['run', 'bids', '--config', 'settings.toml'], { 'settings.toml': '[qsm]\nalgorithm = "autoqsm"\n' }), ['autoqsm.onnx']);
  assert.deepEqual(await named(['run', 'sub-qsmnetstudy', 'out']), [], 'a model name inside another word is not a request');
});

test('TOML pipeline booleans name implicit models only when enabled', async () => {
  for (const [field, expected] of [
    ['do_segmentation', ['synthseg.onnx']],
    ['do_analysis', ['synthseg.onnx']],
    ['do_r2primemap', ['r2primenet.onnx']],
    ['do_chi_separation', ['r2primenet.onnx']],
  ]) {
    for (const enabled of [false, true]) {
      assert.deepEqual(await named(['run', 'bids', 'out', '--config', 'settings.toml'], {
        'settings.toml': `[pipeline]\n${field} = ${enabled}\n`,
      }), enabled ? expected : [], `${field} = ${enabled}`);
    }
  }
});

test('config model fields ignore comments and paths and deduplicate weights', async () => {
  const config = `# xqsm\ndescription = "qsmnet"\n[pipeline]\ndo_analysis = false\n[inversion]\nalgorithm = "nextqsm"\n[[masking.sections]]\ninput = "magnitude"\n[masking.sections.generator]\nop = "hd-bet"\n`;
  assert.deepEqual(await named(['run', '/study/xqsm/bids', '/study/qsmnet/out', '--config=settings.toml', '--qsm-algorithm', 'nextqsm'], {
    'settings.toml': config,
  }), ['nextqsm-bf.onnx', 'nextqsm-vjp.onnx', 'hd-bet.onnx']);
});

test('weights are verified before use and downloaded only when missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('weights');
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.end(request.url === '/bad.onnx' ? Buffer.from('tampered') : bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset = { model: 'demo', filename: 'demo.onnx', bytes: bytes.length, sha256, url: `${base}/demo.onnx` };
  const cacheDir = join(root, 'cache');
  await assert.rejects(ensureModels([asset], { cacheDir, offline: true }), /download-models/);
  assert.equal(requests, 0);
  assert.deepEqual(await ensureModels([asset], { cacheDir }), [join(cacheDir, 'demo.onnx')]);
  assert.deepEqual(await ensureModels([asset], { cacheDir }), [join(cacheDir, 'demo.onnx')]);
  assert.equal(requests, 1);
  await assert.rejects(ensureModels([{ ...asset, filename: 'bad.onnx', url: `${base}/bad.onnx` }], { cacheDir }), /checksum/);
  assert.deepEqual((await readdir(cacheDir)).sort(), ['demo.onnx'], 'a rejected download leaves nothing behind');
  await writeFile(join(cacheDir, 'demo.onnx'), 'corrupt');
  assert.deepEqual(await ensureModels([asset], { cacheDir }), [join(cacheDir, 'demo.onnx')]);
  assert.equal(requests, 3, 'a corrupt cached file is replaced');
});

test('native registry inventory covers all model cache files and rejects drift', () => {
  assert.equal(nativeModelAssets(), MODEL_ASSETS);
  const source = MODEL_ASSETS.map((asset) => `WeightFile { name: "${asset.filename}", url: "${asset.url}", sha256: "${asset.sha256}", bytes: ${asset.bytes} }`).join('\n');
  verifyNativeWeights(source, MODEL_ASSETS, QSMXT.weightFiles);
  for (const assets of [MODEL_ASSETS.slice(1), [...MODEL_ASSETS, { ...MODEL_ASSETS[0], filename: 'unknown.onnx' }], [{ ...MODEL_ASSETS[0], sha256: '0'.repeat(64) }, ...MODEL_ASSETS.slice(1)]]) {
    assert.throws(() => verifyNativeWeights(source, assets, QSMXT.weightFiles), /every hosted native/);
  }
});

test('native weights share one complete verified directory, including a partial offline model pack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-native-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundled = join(root, 'bundled');
  const cacheDir = join(root, 'cache');
  await Promise.all([bundled, cacheDir].map((path) => mkdir(path)));
  const asset = (name, bytes) => ({ model: name, filename: `${name}.onnx`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/never-download' });
  const assets = [asset('first', 'first'), asset('second', 'second')];
  const previous = process.env.NEURODESK_QSMBLY_MODEL_DIR;
  process.env.NEURODESK_QSMBLY_MODEL_DIR = bundled;
  try {
    await writeFile(join(bundled, 'first.onnx'), 'first');
    await assert.rejects(ensureNativeModelDirectory(assets, { cacheDir, offline: true }), /second.onnx.*download-models/);
    await writeFile(join(cacheDir, 'second.onnx'), 'second');
    assert.equal(await ensureNativeModelDirectory(assets, { cacheDir, offline: true }), cacheDir);
    assert.equal(await readFile(join(cacheDir, 'first.onnx'), 'utf8'), 'first');
    await writeFile(join(bundled, 'first.onnx'), 'corrupt');
    assert.equal(await ensureNativeModelDirectory(assets, { cacheDir, offline: true }), cacheDir, 'corrupt pack cannot shadow the verified cache');
    assert.deepEqual([qsmxtEnvironment({ modelDir: cacheDir }).QSM_MODEL_DIR, qsmxtEnvironment({ modelDir: cacheDir }).QSM_MODEL_CACHE], [cacheDir, cacheDir]);
  } finally {
    if (previous === undefined) delete process.env.NEURODESK_QSMBLY_MODEL_DIR;
    else process.env.NEURODESK_QSMBLY_MODEL_DIR = previous;
  }
});

test('both offline switches refuse an incomplete native cache before launching QSMxT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variable of ['QSMBLY_OFFLINE', 'NEURODESK_OFFLINE']) {
    const result = run(['run', 'missing-bids', 'out'], { XDG_CACHE_HOME: root, NEURODESK_QSMBLY_MODEL_DIR: root, [variable]: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bfrnet.onnx.*download-models/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(root), []);
});

test('QSMxT reads only the complete model directory the wrapper verified', () => {
  const previous = process.env.NEURODESK_QSMBLY_MODEL_DIR;
  try {
    process.env.NEURODESK_QSMBLY_MODEL_DIR = '/opt/qsmbly/models';
    assert.deepEqual(
      [qsmxtEnvironment({ modelDir: '/cache' }).QSM_MODEL_DIR, qsmxtEnvironment({ modelDir: '/cache' }).QSM_MODEL_CACHE],
      ['/cache', '/cache'],
    );
    delete process.env.NEURODESK_QSMBLY_MODEL_DIR;
    assert.equal(qsmxtEnvironment({ modelDir: '/cache' }).QSM_MODEL_DIR, '/cache');
  } finally {
    if (previous === undefined) delete process.env.NEURODESK_QSMBLY_MODEL_DIR;
    else process.env.NEURODESK_QSMBLY_MODEL_DIR = previous;
  }
});

test('the wrapper keeps its own commands and refuses to replace the pinned QSMxT', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /download-models/);
  assert.match(help.stdout, new RegExp(`QSMxT ${QSMXT.version.replaceAll('.', '\\.')}`));
  const update = run(['update']);
  assert.equal(update.status, 1);
  assert.match(update.stderr, /Install a newer QSMbly release/);
  const unknown = run(['download-models', '--model', 'nonesuch'], { QSMBLY_OFFLINE: '1' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown model nonesuch/);
});

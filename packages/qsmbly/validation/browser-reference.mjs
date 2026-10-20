// Record the web app's susceptibility map for the pinned example: build the app first
// (pnpm --filter qsmbly build), then run this to rewrite browser-reference.json.
//   node packages/qsmbly/validation/browser-reference.mjs [--output DIR]
// It runs the production bundle's automation in Chromium, as apps/qsmbly/e2e/automation.spec.js
// does, and records the fingerprint of the χ map, the mask, and the qsmxt command the app exports
// for that run. cli-check.mjs replays that command through the command line.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { EXAMPLE, pinnedExample } from './example.mjs';
import { measure } from './measure.mjs';

const REFERENCE = new URL('./browser-reference.json', import.meta.url);
const PARAMETERS = Object.freeze({ echoTimesMs: [20], fieldStrength: 3 });

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve(dist) {
  return createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.includes('..')) return response.writeHead(400).end();
      let path = join(dist, pathname);
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      response.writeHead(200, {
        'content-type': TYPES[extname(path)] || 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function download(page, artifactId) {
  const waiting = page.waitForEvent('download');
  await page.evaluate((id) => neurodeskAutomation.dispatch('download', { artifactId: id }), artifactId);
  return readFile(await (await waiting).path());
}

export async function recordBrowserReference({ dist = resolve('apps/qsmbly/dist'), output } = {}) {
  const files = await pinnedExample();
  const server = serve(dist);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const home = await mkdtemp(join(tmpdir(), 'qsmbly-browser-home-'));
  let browser;
  try {
    browser = await chromium.launch({ env: { ...process.env, HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation && globalThis.app));
    for (const role of ['magnitude', 'phase']) {
      await page.locator('#neurodesk-input-transfer').setInputFiles(files.find((file) => file.role === role).path);
      await page.evaluate((name) => neurodeskAutomation.dispatch('adopt', { role: name }), role);
    }
    const started = Date.now();
    await page.evaluate((parameters) => neurodeskAutomation.dispatch('start', { operation: 'reconstruct', parameters }), PARAMETERS);
    let snapshot;
    do {
      await page.waitForTimeout(1000);
      snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
    } while (!['succeeded', 'failed'].includes(snapshot.state) && Date.now() - started < 900000);
    assert.equal(snapshot.state, 'succeeded', JSON.stringify(snapshot.error ?? snapshot.state));
    const seconds = Math.round((Date.now() - started) / 1000);
    const artifacts = Object.entries(snapshot.report.artifacts);
    const [qsmId] = artifacts.find(([, artifact]) => artifact.role === 'qsm');
    const [maskId] = artifacts.find(([, artifact]) => artifact.role === 'mask');
    const chiBytes = await download(page, qsmId);
    const maskBytes = await download(page, maskId);
    // The command and settings file the app's Export dialog shows for this run.
    await page.evaluate(() => app.showCommandPreview());
    await page.waitForFunction(() => {
      const text = document.getElementById('commandPreviewText')?.textContent ?? '';
      return text.split('\n').some(line => line.startsWith('qsmxt ')) && app._lastToml;
    });
    const command = await page.evaluate(() => document.getElementById('commandPreviewText').textContent.trim());
    const settings = await page.evaluate(() => app._lastToml);
    assert.deepEqual(errors, []);
    const chi = await readNifti(chiBytes, Float64Array);
    const mask = await readNifti(maskBytes, Float64Array);
    if (output) {
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'browser-chi.nii'), chiBytes);
      await writeFile(join(output, 'browser-mask.nii'), maskBytes);
    }
    return {
      browser: `chromium ${browser.version()}`,
      app: `qsmbly ${snapshot.report.provenance.appVersion}`,
      qsmCore: snapshot.report.provenance.qsmCoreVersion,
      qsmCoreCommit: snapshot.report.provenance.qsmCoreCommit,
      qsmxtEngineCommit: snapshot.report.provenance.qsmxtCommit,
      seconds,
      example: { id: EXAMPLE.id, sha256: Object.fromEntries(EXAMPLE.files.map((file) => [file.name, file.sha256])) },
      parameters: PARAMETERS,
      settings: snapshot.report.provenance.settings,
      command,
      configToml: settings,
      artifacts: { chiSha256: createHash('sha256').update(chiBytes).digest('hex'), maskSha256: createHash('sha256').update(maskBytes).digest('hex') },
      measurement: measure({ dims: chi.dims, chi: chi.data, mask: mask.data }),
    };
  } finally {
    await browser?.close();
    await rm(home, { recursive: true, force: true });
    await new Promise((done) => server.close(done));
  }
}

// Number arrays on one line: the block grid has thousands of entries.
export const formatReference = (reference) => `${JSON.stringify(reference, null, 2).replace(/\[\s+((?:-?[\d.]+|null)(?:,\s+(?:-?[\d.]+|null))*)\s+\]/g, (_, items) => `[${items.split(/,\s+/).join(',')}]`)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, dist: { type: 'string' } } });
  const previous = JSON.parse(await readFile(REFERENCE, 'utf8').catch(() => '{}'));
  const reference = await recordBrowserReference({ dist: values.dist && resolve(values.dist), output: values.output });
  const cargo = await readFile(new URL('../../../apps/qsmbly/rust-wasm/Cargo.toml', import.meta.url), 'utf8');
  const pinnedEngine = /qsmxt-engine = \{[^}]*rev = "([0-9a-f]{40})"/.exec(cargo)?.[1];
  assert.equal(reference.qsmxtEngineCommit, pinnedEngine, 'the browser bundle must match its pinned engine');
  // Tolerance and evidence come from comparing the exported command; recording keeps them.
  await writeFile(REFERENCE, formatReference({ ...reference, tolerance: previous.tolerance, observed: previous.observed }));
  console.log(`Recorded ${fileURLToPath(REFERENCE)} in ${reference.seconds} s: ${reference.command}`);
}

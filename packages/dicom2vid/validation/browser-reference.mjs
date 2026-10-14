// Records what the dicom2vid web app writes in Chromium for every validation case
// (browser-reference.json and browser-reference/*.webm), which the command line's release check
// (cli-check.mjs) compares against.
//
// Serves the app's production build (`pnpm --filter dicom2vid build`) on loopback, then runs
// each case through the app's `encode-volume` automation operation with WebCodecs.
//
//   node validation/browser-reference.mjs           rewrite the reference
//   node validation/browser-reference.mjs --check   fail unless the browser still writes it
import { chromium } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeVideo, inspectVideo } from '../src/inspect.js';
import { CASES, exampleFile, sha256 } from './cases.mjs';

const check = process.argv.includes('--check');
// Two encodes of the same frames differ by less than the command line and the browser do
// (35.9 dB at worst); the wrong slice, window or orientation scores 27 dB or less
// (validation/cli-check.mjs).
const MATCH_PSNR_DB = 35;

function lumaPsnr(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : Infinity;
}
const dist = fileURLToPath(new URL('../../../apps/dicom2vid/dist/', import.meta.url));
const referenceDir = new URL('./browser-reference/', import.meta.url);
const referenceJson = new URL('./browser-reference.json', import.meta.url);
const appVersion = JSON.parse(await readFile(new URL('../../../apps/dicom2vid/package.json', import.meta.url), 'utf8')).version;
await readFile(join(dist, 'index.html')).catch(() => {
  throw new Error('Build the app first: pnpm --filter dicom2vid build');
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = normalize(join(dist, path.endsWith('/') ? `${path}index.html` : path));
  const body = file.startsWith(dist) ? await readFile(file).catch(() => undefined) : undefined;
  if (!body) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const work = await mkdtemp(join(tmpdir(), 'dicom2vid-browser-reference-'));
const recorded = {};
try {
  const page = await browser.newPage();
  const dispatch = (command, request = {}) => page.evaluate(
    ({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request),
    { command, request },
  );
  await page.goto(origin);
  await page.locator('#neurodesk-input-transfer').waitFor({ state: 'attached' });
  for (const item of CASES) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(await exampleFile(item.example));
    await dispatch('adopt', { role: 'image' });
    await dispatch('start', { operation: 'encode-volume', parameters: item.parameters });
    let snapshot;
    for (let waited = 0; ; waited += 250) {
      snapshot = await dispatch('snapshot');
      if (snapshot.state !== 'running') break;
      if (waited > 120000) throw new Error(`${item.id}: still running after two minutes`);
      await page.waitForTimeout(250);
    }
    if (snapshot.state !== 'succeeded') throw new Error(`${item.id}: ${JSON.stringify(snapshot.error)}`);
    const download = page.waitForEvent('download');
    await dispatch('download', { artifactId: 'video' });
    const path = join(work, `${item.id}.${item.parameters.format}`);
    await (await download).saveAs(path);
    const bytes = await readFile(path);
    const { summary } = snapshot.report;
    recorded[item.id] = {
      parameters: item.parameters,
      codec: summary.codec,
      container: summary.container,
      sha256: sha256(bytes),
      bytes: bytes.length,
      video: await inspectVideo(bytes),
    };
    if (item.parameters.format === 'webm') recorded[item.id].file = `browser-reference/${item.id}.webm`;
    console.log(`${item.id}: ${summary.codec} ${summary.container} ${summary.frames} frames ${summary.width}x${summary.height}, ${bytes.length} bytes`);
  }
  const reference = {
    note: 'Written by validation/browser-reference.mjs from the production app in Playwright Chromium. Do not edit.',
    app: appVersion,
    chromium: browser.version(),
    cases: recorded,
  };
  if (check) {
    // Every video must have the recorded container facts. The WebM videos must also decode
    // to the recorded frames: byte-identical on the recording machine, and within
    // MATCH_PSNR_DB where another CPU's libvpx paths round differently. MP4 stamps its
    // creation time, so only its facts are compared.
    const committed = JSON.parse(await readFile(referenceJson, 'utf8'));
    const drift = [];
    for (const { id } of CASES) {
      const facts = JSON.stringify(committed.cases[id]?.video) === JSON.stringify(recorded[id].video);
      let frames = 'facts only';
      if (facts && recorded[id].file && committed.cases[id].sha256 !== recorded[id].sha256) {
        const now = await decodeVideo(await readFile(join(work, `${id}.webm`)));
        const then = await decodeVideo(await readFile(new URL(`${id}.webm`, referenceDir)));
        const worst = Math.min(...now.map((frame, k) => lumaPsnr(frame.y, then[k].y)));
        frames = `${worst.toFixed(1)} dB from the recorded frames`;
        if (worst < MATCH_PSNR_DB) drift.push(`${id} (${frames})`);
      } else if (recorded[id].file) {
        frames = 'identical bytes';
      }
      if (!facts) drift.push(`${id} (container facts)`);
      console.log(`${facts ? 'PASS' : 'FAIL'} ${id}: ${frames}`);
    }
    if (drift.length) throw new Error(`The web app no longer writes the recorded videos for ${drift.join(', ')}`);
    console.log('PASS the web app still writes every recorded reference video');
  } else {
    await rm(referenceDir, { recursive: true, force: true });
    await mkdir(referenceDir, { recursive: true });
    for (const [id, entry] of Object.entries(recorded)) {
      if (entry.file) await writeFile(new URL(`${id}.webm`, referenceDir), await readFile(join(work, `${id}.webm`)));
    }
    await writeFile(referenceJson, `${JSON.stringify(reference, null, 2)}\n`);
    console.log(`Wrote ${fileURLToPath(referenceJson)}`);
  }
} finally {
  await browser.close();
  server.close();
  await rm(work, { recursive: true, force: true });
}

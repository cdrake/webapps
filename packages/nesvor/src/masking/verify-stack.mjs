import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeStacks } from '../input.js';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const models = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) throw new Error('Pass a fetal NIfTI stack and external MONAIfbs export directory.');
const bytes = await readFile(process.argv[2]);
const [decoded] = decodeStacks([{ image: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), thickness: 1.25 }]);
const area = decoded.shape[0] * decoded.shape[1];
const firstSlice = Math.floor(decoded.shape[2] / 2) - 1;
const stack = { shape: [...decoded.shape.slice(0, 2), 3], resolution: decoded.resolution, data: [...decoded.data.slice(firstSlice * area, (firstSlice + 3) * area)], mask: [...decoded.mask.slice(firstSlice * area, (firstSlice + 3) * area)], sourceSha256: createHash('sha256').update(bytes).digest('hex'), firstSlice };
await writeFile(resolve(models, 'stack.json'), JSON.stringify(stack));
if (process.argv.includes('--prepare')) process.exit(0);
const runtime = fileURLToPath(new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>MONAIfbs verification</title>');
      return;
    }
    const filename = url.pathname.split('/').pop();
    const path = url.pathname.startsWith('/models/') ? resolve(models, filename) : url.pathname.startsWith('/runtime/') ? resolve(runtime, filename) : resolve(root, '.' + url.pathname);
    response.setHeader('Content-Type', { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const provider = process.env.NESVOR_MASK_PROVIDER || 'wasm';
if (!['wasm', 'webgpu'].includes(provider)) throw new Error('NESVOR_MASK_PROVIDER must be wasm or webgpu');
const hardware = process.env.NESVOR_REQUIRE_HARDWARE === '1';
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(hardware ? [] : ['--use-angle=swiftshader'])] });
try {
  const page = await browser.newPage();
  page.on('console', message => { if (message.type() === 'log') console.error(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ modelBaseUrl, provider, hardware }) => {
    let adapterInfo;
    if (provider === 'webgpu') {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('WebGPU adapter unavailable');
      adapterInfo = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter };
      if (hardware && (![adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description].some(Boolean) || adapterInfo.fallback || /swiftshader|llvmpipe|lavapipe|software/i.test(JSON.stringify(adapterInfo)))) throw new Error('Hardware WebGPU required; refusing software adapter');
    }
    const runtime = await import(provider === 'webgpu' ? '/runtime/ort.webgpu.min.mjs' : '/runtime/ort.wasm.min.mjs');
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.wasmPaths = new URL('/runtime/', location.href).href;
    const { createMaskInference } = await import('/packages/nesvor/src/masking/index.js');
    const manifest = await (await fetch('/models/manifest.json')).json();
    const infer = await createMaskInference({ runtime, manifest, executionProviders: [provider], baseUrl: modelBaseUrl ?? new URL('/models/', location.href).href });
    try {
      const { segmentStacks } = await import('/packages/nesvor/src/masking/index.js');
      const fixture = await (await fetch('/models/stack.json')).json();
      const expected = new Uint8Array(await (await fetch('/models/stack-mask.u8')).arrayBuffer());
      const stack = { ...fixture, data: Float32Array.from(fixture.data), mask: Uint8Array.from(fixture.mask) };
      const start = performance.now();
      const [actual] = await segmentStacks([stack], { infer, onProgress: event => console.log(JSON.stringify({ ...event, elapsedSeconds: (performance.now() - start) / 1000 })) });
      if (actual.mask.length !== expected.length) throw new Error('Mask dimensions differ from upstream fixture.');
      let disagreements = 0;
      let foreground = 0;
      let expectedForeground = 0;
      let intersection = 0;
      for (let i = 0; i < expected.length; i++) {
        disagreements += actual.mask[i] !== expected[i];
        foreground += actual.mask[i];
        expectedForeground += expected[i];
        intersection += actual.mask[i] & expected[i];
      }
      const dice = 2 * intersection / (foreground + expectedForeground);
      if (!foreground || dice < .999) throw new Error(`Fetal mask differs: Dice ${dice}, browser foreground ${foreground}, upstream ${expectedForeground}`);
      return { passed: true, provider, adapterInfo, fixture: 'three central slices from SVRTK simulated fetal stack', shape: fixture.shape, firstSlice: fixture.firstSlice, sourceSha256: fixture.sourceSha256, foreground, expectedForeground, disagreements, dice, elapsedSeconds: (performance.now() - start) / 1000 };

    } finally {
      await infer.release();
    }
  }, { modelBaseUrl: process.env.NESVOR_VERIFY_MODEL_URL ?? null, provider, hardware });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

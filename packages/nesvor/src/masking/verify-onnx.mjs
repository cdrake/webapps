import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const models = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass an external MONAIfbs export directory.');
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
      const input = new Float32Array(await (await fetch('/models/input.f32')).arrayBuffer());
      const expected = new Float32Array(await (await fetch('/models/logits.f32')).arrayBuffer());
      const start = performance.now();
      const actual = await infer(input, [1, 1, 448, 512]);
      let maximum = 0;
      let disagreements = 0;
      const area = actual.length / 2;
      for (let i = 0; i < actual.length; i++) {
        const error = Math.abs(actual[i] - expected[i]);
        maximum = Math.max(maximum, error);
        if (!Number.isFinite(error) || error > .003 + .0003 * Math.abs(expected[i])) throw new Error(`MONAIfbs logits differ at ${i}: ${actual[i]} versus ${expected[i]}`);
      }
      for (let i = 0; i < area; i++) disagreements += (actual[i] < actual[i + area]) !== (expected[i] < expected[i + area]);
      return { passed: true, provider, adapterInfo, elapsedSeconds: (performance.now() - start) / 1000, maxAbsoluteError: maximum, argmaxDisagreements: disagreements };
    } finally {
      await infer.release();
    }
  }, { modelBaseUrl: process.env.NESVOR_VERIFY_MODEL_URL ?? null, provider, hardware });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

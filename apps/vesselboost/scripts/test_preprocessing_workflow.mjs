import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const site = await serveSite(new URL('../dist/', import.meta.url).pathname);
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  // These preprocessing stages do not use the model cache or download models.
  await page.route('https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm', route => route.fulfill({
    contentType: 'text/javascript',
    body: 'export default { config() {} };',
  }));
  await page.route('**/preprocessing-test.html', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Preprocessing regression</title>',
  }));
  await page.goto(`${site.origin}/preprocessing-test.html`);
  const results = await page.evaluate(async () => {
    const { createNiftiFromVolume, parseNiftiVolume } = await import('./vendor/webapp-components/src/file-io/NiftiUtils.js');
    const size = 16;
    const img = new Float32Array(size ** 3);
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (Math.hypot(x - 7.5, y - 7.5, z - 7.5) < 6) {
            img[x + size * (y + size * z)] = 100 + x * 2 + (y % 3);
          }
        }
      }
    }
    const inputData = createNiftiFromVolume({
      img,
      hdr: {
        dims: [3, size, size, size, 1, 1, 1, 1],
        pixDims: [1, 1, 1, 1, 1, 1, 1, 1],
        affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
      },
    });
    const worker = new Worker('./js/inference-worker.js', { type: 'module' });
    function request(message, done) {
      return new Promise((resolve, reject) => {
        const stages = [];
        const timeout = setTimeout(() => reject(new Error(`${message.type} timed out`)), 60000);
        worker.onerror = event => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        };
        worker.onmessage = ({ data }) => {
          if (data.type === 'stageData') stages.push(data);
          if (data.type === 'error' || done(data)) {
            clearTimeout(timeout);
            if (data.type === 'error') reject(new Error(data.message));
            else resolve({ ...data, stages });
          }
        };
        worker.postMessage(message);
      });
    }
    try {
      const init = await request({ type: 'init' }, data => data.type === 'initialized');
      if (!init.wasmPreprocessingAvailable) throw new Error('Built preprocessing WASM must be available');
      const results = [];
      for (const [type, step, data] of [
        ['run-n4', 'n4', {}],
        ['run-bet', 'bet', {}],
        ['run-denoise', 'denoise', { method: 'bilateral' }],
        ['run-denoise', 'denoise', { method: 'nlm-fast' }],
        ['run-denoise', 'denoise', { method: 'nlm' }],
      ]) {
        await request({ type: 'load', data: { inputData } }, result => result.type === 'step-complete' && result.step === 'load');
        const result = await request({ type, data }, result => result.type === 'step-complete' && result.step === step);
        results.push({
          method: data.method || step,
          volumes: result.stages.map(stage => {
            const volume = parseNiftiVolume(stage.niftiData);
            return {
              dims: volume.dims,
              length: volume.imageData.length,
              finite: volume.imageData.every(Number.isFinite),
              nonempty: volume.imageData.some(value => value > 0),
            };
          }),
        });
      }
      return results;
    } finally {
      worker.terminate();
    }
  });
  for (const { method, volumes } of results) {
    assert.ok(volumes.length > 0, `${method} must emit an output volume`);
    for (const volume of volumes) {
      assert.deepEqual(volume.dims, [16, 16, 16]);
      assert.equal(volume.length, 16 ** 3);
      assert.ok(volume.finite, `${method} must return finite voxels`);
      assert.ok(volume.nonempty, `${method} must return a nonempty volume`);
    }
    console.log(`${method}: real worker and WASM produced valid output`);
  }
} finally {
  await browser.close();
  await site.close();
}

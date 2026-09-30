import { chromium } from '@playwright/test';
import { createServer } from '../../../../apps/nesvor/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  publicDir: `${root}apps/nesvor/public`,
  optimizeDeps: { noDiscovery: true, entries: [] },
  plugins: [{
    name: 'verification-page',
    configureServer(server) {
      server.middlewares.use((_request, response, next) => {
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
      server.middlewares.use('/verify', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>NeSVoR verification</title>');
      });
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 4199,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4199/verify');
  const report = await page.evaluate(async () => {
    const { runBrowserReconstruction } = await import('/packages/nesvor/src/browser.js');
    const { writeVolume, readVolume } = await import('/packages/synthsr/src/volume.js');
    const dims = [8, 8, 8];
    const data = Float32Array.from({ length: 512 }, (_, i) => 1 + i / 512);
    const affines = [
      [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 3, 30], [0, 0, 0, 1]],
      [[0, 0, 3, 3], [1, 0, 0, 20], [0, 1, 0, 37], [0, 0, 0, 1]],
      [[1, 0, 0, 10], [0, 0, -3, 34], [0, 1, 0, 37], [0, 0, 0, 1]],
    ];
    const stacks = affines.map((affine) => ({ image: writeVolume({ data, dims, affine }), thickness: 3 }));
    const options = { registration: 'none', iterations: 1, batchSize: 2, log2HashmapSize: 3, outputResolution: 3 };
    const checkOutput = (result, events) => {
      const volume = readVolume(result.volume);
      if (!volume.data.every(Number.isFinite) || !volume.data.some((v) => v > 0)) throw new Error('Invalid reconstruction');
      if (!volume.data.some((v) => v === 0)) throw new Error('Output support mask was not applied');
      const stages = events.map((event) => event.stage);
      const batches = events.filter((event) => event.stage === 'training-batch');
      if (!batches.some((event) => event.completed === 0) || !batches.some((event) => event.completed === event.total)) throw new Error('Missing measured batch progress');
      if (!stages.includes('training') || !stages.includes('support-mask') || !stages.includes('sampling')) throw new Error('Incomplete workflow');
      const positive = volume.data.filter((v) => v > 0);
      const mean = positive.reduce((sum, v) => sum + v, 0) / positive.length;
      if (Math.abs(mean - 700) > 1e-3) throw new Error('Output intensity normalization failed');
      if (result.provenance.config.samples !== 256 || result.provenance.outputSamples !== 512) throw new Error('Scientific PSF defaults changed for verification');
      return { dimensions: volume.dims, outputMean: mean, supportedVoxels: positive.length, stages: [...new Set(stages)] };
    };
    const events = [];
    const result = await runBrowserReconstruction({ stacks, options }, { onProgress: (event) => events.push(event) });
    const rigid = checkOutput(result, events);
    const controller = new AbortController();
    let cancelled = false;
    try {
      await runBrowserReconstruction({ stacks, options: { ...options, iterations: 2 } }, {
        signal: controller.signal,
        onProgress: (event) => { if (event.stage === 'training') controller.abort(); },
      });
    } catch (error) {
      cancelled = error.name === 'AbortError';
    }
    if (!cancelled) throw new Error('Worker cancellation did not abort the run');
    const biasDims = [16, 16, 8];
    const biasedData = Float32Array.from({ length: 2048 }, (_, i) => {
      const x = i % 16;
      const y = Math.floor(i / 16) % 16;
      const z = Math.floor(i / 256);
      return (50 + 40 * Number(x > 7) + 15 * Number(y > 7)) * Math.exp(0.025 * x + 0.012 * z);
    });
    const biasedStacks = affines.map((affine) => ({ image: writeVolume({ data: biasedData, dims: biasDims, affine }), thickness: 3 }));
    const combinedEvents = [];
    const combinedResult = await runBrowserReconstruction({
      stacks: biasedStacks,
      options: { ...options, biasFieldCorrection: true, deformable: true },
      runtime: { n4BaseUrl: new URL('/n4/', location.href).href },
    }, { onProgress: (event) => combinedEvents.push(event) });
    const combined = checkOutput(combinedResult, combinedEvents);
    if (!combinedResult.provenance.preprocessing.biasFieldCorrection || !combinedResult.provenance.config.deformable) throw new Error('Missing N4/deformation provenance');
    if (combinedResult.provenance.preprocessing.segmentation || combinedResult.provenance.registration.mode !== 'none') throw new Error('Non-fetal fixture must not invoke learned fetal registration or masking');
    if (combinedEvents.filter((event) => event.stage === 'bias-correction').length !== 2 * biasedStacks.length) throw new Error('N4 did not run for every stack');
    if (!combined.stages.includes('n4-runtime-ready')) throw new Error('Pinned N4 runtime did not initialize');
    const losses = combinedEvents.find((event) => event.stage === 'training')?.losses;
    if (!Number.isFinite(losses?.deformReg)) throw new Error('Deformation regularization was not evaluated');
    return {
      passed: true,
      cancelled,
      engine: result.provenance.engine,
      rigid,
      n4AndDeformation: { ...combined, deformReg: losses.deformReg, preprocessing: combinedResult.provenance.preprocessing },
      trainingPreset: options,
      trainingSamples: 256,
      outputSamples: 512,
      adapter: 'Chromium SwiftShader software WebGPU',
      cudaParity: false,
      clinicalValidation: false,
    };
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}

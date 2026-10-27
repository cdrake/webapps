import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { createWorkerEmitter, fetchModel, getOptimalWasmThreads, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { runInference } from '../vendor/seedseg/src/pipeline.js';

const messages = createWorkerEmitter(self);
let niftiReady;
let qsm;
const loadDependencies = () => niftiReady ||= import('../nifti-js/index.js');

installWorkerRouter({
  scope: self,
  getServices: loadDependencies,
  handle: async ({ type, data }) => {
    if (type === 'init') {
      ort.env.wasm.numThreads = Math.min(4, getOptimalWasmThreads());
      ort.env.wasm.wasmPaths = '../wasm/';
      qsm = await import(new URL('../wasm/qsm_wasm.js', import.meta.url).href);
      await qsm.default({ module_or_path: new URL('../wasm/qsm_wasm_bg.wasm', import.meta.url) });
      messages.initialized({ threads: ort.env.wasm.numThreads, webgpuAvailable: typeof navigator.gpu !== 'undefined' });
    } else if (type === 'run') {
      const settings = data.settings;
      // v2 tries WebGPU first and falls back to WebAssembly per network, as upstream does.
      const webgpu = settings.backend !== 'wasm' && Boolean(await navigator.gpu?.requestAdapter());
      await runInference(data.inputData, {
        ...settings,
        backends: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
        Tensor: ort.Tensor,
        qsm,
        decompress: bytes => globalThis.nifti.decompress(bytes),
        createSession: (bytes, backend = 'wasm') => ort.InferenceSession.create(bytes, {
          executionProviders: [backend], graphOptimizationLevel: 'all',
        }),
        loadModel: async (asset, name, base, span) => {
          const { url } = asset;
          const bytes = await fetchModel({ url, urls: [url, url], cacheKey: url,
            integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
            onInvalidCache: error => messages.log(`Discarding cached model: ${error.message}`),
            onCacheError: error => messages.log(`Model cache unavailable: ${error.message}`),
            onProgress: ({ fraction }) => {
              if (fraction !== null) messages.progress(base + fraction * span, `Downloading ${name}...`);
            },
          });
          messages.log(`Verified ${name} (${(bytes.byteLength / 1048576).toFixed(1)} MB)`);
          return bytes;
        },
        events: {
          log: message => messages.log(message),
          progress: (fraction, message) => messages.progress(fraction, message),
          stageData: (stage, bytes, description) => messages.stageData(stage, bytes, description),
          detections: detections => messages.emit('metrics', { metrics: detections }, { transfer: false }),
        },
      });
      messages.complete();
    }
  },
});

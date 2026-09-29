import * as ort from 'onnxruntime-web/webgpu';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import wasmModuleURL from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { readVolume, writeVolume } from '@neurodesk/synthsr';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { browserSynthstrip } from '../../../packages/syncro/src/assets.js';
import { flamesModel } from './model.js';
import { PLAN, segmentFlair, threshold, labelLesions, lesionTable } from './pipeline.js';

ort.env.wasm.wasmPaths = { wasm: wasmURL, mjs: wasmModuleURL };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 1) : 1;

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const log = (message) => self.postMessage({ type: 'log', message });

async function modelCache() {
  try {
    const storage = await caches.open('neurodesk-models-v1');
    return {
      async get(key) { return (await storage.match(key))?.arrayBuffer(); },
      async set(key, bytes) { await storage.put(key, new Response(bytes)); },
      async delete(key) { await storage.delete(key); },
    };
  } catch {
    return null;
  }
}

async function download(asset, label, from, to, cache) {
  progress(from, `Downloading ${label}…`);
  return fetchModel({ url: asset.url, integrity: { bytes: asset.bytes, sha256: asset.sha256 } }, {
    cache,
    onProgress: ({ fraction }) => progress(from + (to - from) * (fraction || 0), `Downloading ${label}…`),
  });
}

async function brainMask(volume, cache) {
  const result = await runSynthstrip({
    volume,
    loadModel: async () => ({ bytes: await download(browserSynthstrip, 'brain extraction model', 0.02, 0.08, cache), hash: browserSynthstrip.sha256 }),
    createSession: (bytes) => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }),
    Tensor: ort.Tensor,
    onProgress: (value, message) => progress(0.08 + 0.12 * value, message),
  });
  return result.mask.data;
}

async function segment(bytes, backend, volume, brainMask) {
  progress(0.3, 'Preparing FLAMeS…');
  const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all' });
  log(`FLAMeS on ${backend === 'webgpu' ? 'WebGPU' : `WebAssembly, ${ort.env.wasm.numThreads} threads`}`);
  try {
    return await segmentFlair({
      volume,
      brainMask,
      runPatch: async (tile) => {
        const input = new ort.Tensor('float32', tile, [1, 1, ...PLAN.patch]);
        const outputs = await session.run({ [session.inputNames[0]]: input });
        const logits = outputs[session.outputNames[0]];
        const data = await logits.getData();
        input.dispose();
        logits.dispose();
        return data;
      },
      onPatch: (n, total) => progress(0.3 + 0.65 * n / total, `Segmenting lesions · patch ${n} of ${total}`),
    });
  } finally {
    await session.release();
  }
}

self.onmessage = async ({ data: job }) => {
  try {
    const volume = readVolume(await job.file.arrayBuffer());
    const cache = await modelCache();
    let mask;
    if (job.skullStripped) {
      mask = Uint8Array.from(volume.data, (v) => (v !== 0 ? 1 : 0));
      progress(0.2, 'Using nonzero voxels as the brain');
    } else {
      mask = await brainMask(volume, cache);
    }
    const bytes = await download(flamesModel, 'FLAMeS model', 0.2, 0.3, cache);
    const started = performance.now();
    let backend = job.backend;
    let result;
    try {
      result = await segment(bytes, backend, volume, mask);
    } catch (error) {
      if (backend !== 'webgpu') throw error;
      log(`WebGPU failed (${error.message}); continuing on the CPU`);
      backend = 'wasm';
      result = await segment(bytes, backend, volume, mask);
    }
    const { probability, windows, resampledShape } = result;
    const lesionMask = threshold(probability);
    const { lesions } = labelLesions(lesionMask, volume.dims);
    const table = lesionTable(lesions, volume.affine);
    const geometry = { dims: volume.dims, affine: volume.affine };
    const maskBuffer = writeVolume({ ...geometry, data: lesionMask }, 'FLAMeS lesion mask');
    const probabilityBuffer = writeVolume({ ...geometry, data: probability }, 'FLAMeS lesion probability');
    self.postMessage({
      type: 'result',
      mask: maskBuffer,
      probability: probabilityBuffer,
      tsv: table.tsv,
      summary: { count: table.rows.length, totalMl: table.totalMl },
      provenance: {
        model: flamesModel.filename,
        sha256: flamesModel.sha256,
        backend,
        brainMask: job.skullStripped ? 'nonzero voxels' : 'SynthStrip',
        resampledShape,
        windows,
        seconds: Math.round((performance.now() - started) / 100) / 10,
      },
    }, [maskBuffer, probabilityBuffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};

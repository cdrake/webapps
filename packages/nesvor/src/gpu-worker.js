import { reconstructBrowser } from './workflow.js';
import { browserConfig } from './config.js';
import { createOnnxLearnedStep } from './registration/onnx.js';
import { createMaskInference } from './masking/index.js';
import { createN4Corrector } from './n4/loader.js';
import svortManifest from './registration/svort-manifest.json';
import maskManifest from './masking/manifest.json';
import n4Manifest from './n4/manifest.json';

self.onmessage = async ({ data }) => {
  let learned;
  let masking;
  let runtime;
  const onProgress = (progress) => self.postMessage({ type: 'progress', progress });
  const getRuntime = async () => {
    if (!runtime) {
      if (!data.runtime?.wasmBaseUrl) throw new Error('Learned preprocessing requires the ONNX browser runtime assets.');
      runtime = await import('onnxruntime-web/webgpu');
      runtime.env.wasm.numThreads = 1;
      runtime.env.wasm.wasmPaths = data.runtime.wasmBaseUrl;
      const response = await fetch(new URL('ort-wasm-simd-threaded.jsep.wasm.gz', data.runtime.wasmBaseUrl));
      if (!response.ok) throw new Error(`ONNX runtime download failed (${response.status}).`);
      runtime.env.wasm.wasmBinary = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    return runtime;
  };
  const learnedStep = async (request) => {
    learned ??= await createOnnxLearnedStep({ runtime: await getRuntime(), manifest: svortManifest, baseUrl: data.runtime?.modelBaseUrl, onProgress });
    return learned(request);
  };
  learnedStep.release = async () => {
    const active = learned;
    learned = undefined;
    await active?.release();
  };
  const inferMask = async (...args) => {
    masking ??= await createMaskInference({ runtime: await getRuntime(), executionProviders: ['webgpu'], manifest: maskManifest, onProgress: (progress) => onProgress({ stage: 'segmentation-model-download', ...progress }) });
    return masking(...args);
  };
  inferMask.release = async () => {
    const active = masking;
    masking = undefined;
    await active?.release();
  };
  try {
    const config = browserConfig(data);
    const correctBiasField = data.options?.biasFieldCorrection
      ? await createN4Corrector({ baseUrl: data.runtime?.n4BaseUrl, manifest: n4Manifest, onProgress })
      : undefined;
    const result = await reconstructBrowser(data, { learnedStep: config.registration.startsWith('svort') ? learnedStep : undefined, inferMask, correctBiasField, onProgress });
    await learnedStep.release();
    await inferMask.release();
    self.postMessage({ type: 'complete', result }, [result.volume]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  } finally {
    await learnedStep.release();
    await inferMask.release();
  }
};

import { fetchModel } from '../../../components/src/worker/fetchModel.js';

const SOURCE = '730ddaa3711a2304386de34193ea4b957892fe7b';

export async function createOnnxLearnedStep({ runtime, manifest, baseUrl = manifest?.base_url, fetch: fetchAsset = globalThis.fetch, executionProviders = ['wasm'], signal, onProgress = () => {} }) {
  if (manifest?.source_commit !== SOURCE || manifest?.models?.length !== 2 || !/^[a-f0-9]{64}$/.test(manifest.checkpoint_sha256 ?? '')) throw new Error('Invalid pinned SVoRT model manifest.');
  const sessions = [];
  try {
    for (let index = 0; index < 2; index++) {
      signal?.throwIfAborted();
      const record = manifest.models[index];
      if (record.file !== `svort-v2-step-${index}.onnx` || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) throw new Error('Invalid SVoRT graph identity.');
      const bytes = await fetchModel({ url: new URL(record.file, baseUrl).href, urls: [...new Set([baseUrl, manifest.base_url].filter(Boolean).map((base) => new URL(record.file, base).href))], integrity: { sha256: record.sha256, bytes: record.bytes } }, {
        signal,
        fetch: (url, options) => fetchAsset(url, { ...options, credentials: 'omit', redirect: 'follow' }),
        onProgress: (progress) => onProgress({ stage: 'svort-model-download', model: index, ...progress }),
      });
      signal?.throwIfAborted();
      onProgress({ stage: 'svort-model-init', model: index });
      sessions.push(await runtime.InferenceSession.create(bytes, { executionProviders, graphOptimizationLevel: 'all' }));
      onProgress({ stage: 'svort-model', completed: index + 1, total: 2 });
    }
  } catch (error) {
    await Promise.all(sessions.map((session) => session.release()));
    throw error;
  }
  const step = async ({ iteration, theta, slices, positions, estimated, count, sliceShape, signal: runSignal }) => {
    runSignal?.throwIfAborted();
    const session = sessions[iteration === 0 ? 0 : 1];
    const [width, height] = sliceShape;
    const available = {
      theta: new runtime.Tensor('float32', Float32Array.from(theta), [count, 9]),
      slices: new runtime.Tensor('float32', Float32Array.from(slices), [count, 1, height, width]),
      positions: new runtime.Tensor('float32', Float32Array.from(positions), [count, 2]),
      estimated: new runtime.Tensor('float32', Float32Array.from(estimated), [count, 1, height, width]),
    };
    let result;
    try {
      result = await session.run(Object.fromEntries(session.inputNames.map((name) => [name, available[name]])));
      runSignal?.throwIfAborted();
      return { theta: Float32Array.from(result.theta_out.data), score: Float32Array.from(result.score.data) };
    } finally {
      Object.values(available).forEach((tensor) => tensor.dispose());
      Object.values(result ?? {}).forEach((tensor) => tensor.dispose());
    }
  };
  step.release = () => Promise.all(sessions.map((session) => session.release()));
  return step;
}

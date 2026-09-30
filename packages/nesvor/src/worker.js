import { reconstructReference } from './reference-workflow.js';

self.onmessage = async ({ data }) => {
  try {
    const result = await reconstructReference(data, { onProgress: (progress) => self.postMessage({ type: 'progress', progress }) });
    self.postMessage({ type: 'complete', result }, [result.volume]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};

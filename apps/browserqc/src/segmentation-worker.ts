import { segment } from '@brainchop/mindgrab'

self.onmessage = async ({ data }: MessageEvent<unknown>) => {
  try {
    if (!data || typeof data !== 'object' || !('input' in data) || !(data.input instanceof Uint8Array)
      || !('backend' in data) || (data.backend !== 'auto' && data.backend !== 'cpu')
      || !('assetPath' in data) || typeof data.assetPath !== 'string') throw new Error('Invalid segmentation request.')
    const result = await segment(data.input, {
      model: '16chan18cls', backend: data.backend, worker: false,
      assetPath: data.assetPath, timeoutMs: 15 * 60_000,
    })
    self.postMessage({ image: result.image, backend: result.backend, elapsedMs: result.elapsedMs }, { transfer: [result.image] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

import type { SegmentResult } from '@brainchop/mindgrab'
import { runAbortable } from '@neurodesk/webapp-components/automation'

export type SegmentationBackend = 'auto' | 'cpu'
export type SegmentationResult = Pick<SegmentResult, 'image' | 'backend' | 'elapsedMs'>
export const SEGMENTATION_TIMEOUT_MS = 15 * 60_000

export function parseSegmentationResult(value: unknown): SegmentationResult {
  if (!value || typeof value !== 'object' || !('image' in value) || !(value.image instanceof ArrayBuffer)
    || value.image.byteLength === 0 || !('backend' in value)
    || !('elapsedMs' in value) || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) {
    throw new Error('Segmentation worker returned an invalid result.')
  }
  const { image, backend, elapsedMs } = value
  if (backend !== 'cpu' && backend !== 'webgpu' && backend !== 'webgl2') throw new Error('Unknown segmentation backend.')
  return { image, backend, elapsedMs }
}

export async function runSegmentation(input: Uint8Array, backend: SegmentationBackend, signal: AbortSignal): Promise<SegmentationResult> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./segmentation-worker.ts', import.meta.url), { type: 'module' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await runAbortable(signal, () => new Promise<SegmentationResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Segmentation timed out.')), SEGMENTATION_TIMEOUT_MS)
      worker.onmessage = ({ data }: MessageEvent<unknown>) => {
        try {
          if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') throw new Error(data.error)
          resolve(parseSegmentationResult(data))
        } catch (error) { reject(error) }
      }
      worker.onerror = event => reject(new Error(event.message || 'Segmentation worker failed.'))
      worker.onmessageerror = () => reject(new Error('Segmentation worker returned an unreadable result.'))
      worker.postMessage({ input, backend, assetPath: new URL(`${import.meta.env.BASE_URL}brainchop/`, document.baseURI).href })
    }), () => worker.terminate())
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}

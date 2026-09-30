import { version as mindgrabVersion } from '@brainchop/mindgrab/package.json'
import { segment } from '@brainchop/mindgrab'
import { cropB0Volume, fitTensor } from './dtifit'
import type { DwiInput } from './state'

self.onmessage = async ({ data }: MessageEvent<{ input: DwiInput; assetPath: string }>) => {
  try {
    let mask: File | undefined
    let maskFailure: string | null = null
    let maskProvenance: { model: string; version: string; backend: string; elapsedMs: number } | null = null
    self.postMessage({ type: 'progress', message: 'Brain extraction (mindgrab)…' })
    try {
      const b0 = await cropB0Volume(data.input)
      const result = await segment(await b0.arrayBuffer(), { model: 'mindgrab', mask: true, worker: false, backend: 'webgpu', assetPath: data.assetPath })
      maskProvenance = { model: 'mindgrab', version: mindgrabVersion, backend: result.backend, elapsedMs: result.elapsedMs }
      if (result.mask) mask = new File([result.mask], 'mask.nii.gz')
      else maskFailure = 'MindGrab returned no brain mask'
    } catch (error) {
      maskFailure = error instanceof Error ? error.message : String(error)
    }
    self.postMessage({ type: 'progress', message: maskFailure ? `Brain mask failed (${maskFailure}) — fitting without a mask.` : 'Fitting the diffusion tensor (niimath dtifit)…' })
    const maps = await fitTensor(data.input, mask)
    self.postMessage({ type: 'result', result: { maps, masked: Boolean(mask), maskFailure, maskProvenance } })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

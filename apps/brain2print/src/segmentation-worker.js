import { segment, segmentTissues } from '@brainchop/mindgrab'

self.onmessage = async ({ data: { input, tissues, options } }) => {
  try {
    const run = tissues ? segmentTissues : segment
    const result = await run(input, { ...options, worker: false, timeoutMs: 900000 })
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}

// Spreads the volumes of a series over a few workers and collects the corrected series.

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

/** Corrects every volume of `data` (dims[0] × dims[1] × dims[2] × frames, frame-major). */
export function correctVolumes({ data, dims, frames, axes, signal, onProgress }) {
  const voxels = dims[0] * dims[1] * dims[2];
  const out = new Float32Array(data.length);
  const workers = [];
  return new Promise((resolve, reject) => {
    let next = 0;
    let done = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      for (const worker of workers) worker.terminate();
      if (error) reject(error);
      else resolve(out);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Correction cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    const send = (worker) => {
      if (next >= frames) return;
      const id = next++;
      const volume = data.slice(id * voxels, (id + 1) * voxels);
      worker.postMessage({ id, data: volume, dims, axes }, [volume.buffer]);
    };
    for (let w = 0; w < Math.min(workerCount(), frames); w++) {
      const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      workers.push(worker);
      worker.onerror = (event) => finish(new Error(event.message || "A correction worker failed."));
      worker.onmessage = ({ data: message }) => {
        if (message.error) return finish(new Error(message.error));
        out.set(message.data, message.id * voxels);
        done++;
        onProgress?.(done / frames);
        if (done === frames) finish();
        else send(worker);
      };
      send(worker);
    }
  });
}

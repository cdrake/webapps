// Spreads the masked voxels over a few fitting workers, chunk by chunk, and collects the maps.
import { chunks, emptyMaps, gatherChunk, scatterChunk } from "./pipeline.js";

const CHUNK_VOXELS = 2048;

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

/**
 * Fits the tensor (unless `tensor` is false) and NODDI (when `noddi`) to every voxel in `indices`.
 * @returns {Promise<{ tensor: Record<string, Float32Array> | null, noddi: Record<string, Float32Array> | null }>}
 */
export function fitVolume({ data, voxels, volumes, indices, bvals, bvecs, weighted, tensor = true, noddi, signal, onProgress }) {
  const work = chunks(indices, CHUNK_VOXELS);
  const tensorMaps = tensor ? emptyMaps("tensor", voxels) : null;
  const noddiMaps = noddi ? emptyMaps("noddi", voxels) : null;
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
      else resolve({ tensor: tensorMaps, noddi: noddiMaps });
    };
    const abort = () => finish(signal.reason ?? new DOMException("Fitting cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (!work.length) return finish();
    const send = (worker) => {
      if (next >= work.length) return;
      const id = next++;
      const chunk = gatherChunk(data, voxels, volumes, work[id]);
      worker.postMessage({ type: "fit", id, data: chunk, voxels: work[id].length }, [chunk.buffer]);
    };
    for (let w = 0; w < Math.min(workerCount(), work.length); w++) {
      const worker = new Worker(new URL("./fit-worker.js", import.meta.url), { type: "module" });
      workers.push(worker);
      worker.onerror = (event) => finish(new Error(event.message || "A fitting worker failed."));
      worker.onmessage = ({ data: message }) => {
        if (message.type === "error") return finish(new Error(message.message));
        if (message.type === "ready") return send(worker);
        if (message.type !== "done") return;
        if (tensorMaps && message.tensor) scatterChunk(tensorMaps, message.tensor, work[message.id]);
        if (noddiMaps && message.noddi) scatterChunk(noddiMaps, message.noddi, work[message.id]);
        done++;
        onProgress?.(done / work.length);
        if (done === work.length) finish();
        else send(worker);
      };
      worker.postMessage({ type: "init", bvals, bvecs, weighted, tensor, noddi });
    }
  });
}

/**
 * Fits the tensor with niimath dtifit in a worker (see dtifit.js). Cancelling stops the worker.
 * @returns {Promise<Record<string, Float32Array>>} the maps with the WebAssembly fit's keys
 */
export function fitDtifitVolume(input, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./dtifit-worker.js", import.meta.url), { type: "module" });
    const finish = (error, tensor) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(tensor);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Fitting cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "The niimath dtifit worker failed."));
    worker.onmessage = ({ data: message }) => {
      if (message.type === "error") finish(new Error(message.message));
      else if (message.type === "done") finish(null, message.tensor);
    };
    worker.postMessage(input);
  });
}

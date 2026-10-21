// The web app's fitting pool: the shared backend selection on a few Web Workers.
import { fitVolume as fitShared } from "@neurodesk/noddi/fit-pool";

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

const spawn = () => new Worker(new URL("./fit-worker.js", import.meta.url), { type: "module" });

/**
 * Runs the shared tensor and NODDI fit with the browser worker adapters.
 * @returns {Promise<{ tensor: Record<string, Float32Array>, noddi: Record<string, Float32Array> | null }>}
 */
export function fitVolume(options) {
  return fitShared({ ...options, spawn, workers: workerCount(), dtifit: fitDtifitVolume });
}

/** Runs niimath dtifit in its own worker; cancellation terminates its module and filesystem. */
function fitDtifitVolume(input, signal) {
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

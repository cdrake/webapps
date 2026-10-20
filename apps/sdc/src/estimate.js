// Runs one estimate in a fresh worker, so that cancelling terminates the computation.

/** @returns {Promise<{ field: Float64Array, corrected1: Float64Array, corrected2: Float64Array, iterations: number }>} */
export function estimateField({ image1, image2, dims, voxel, options, signal }) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      finish();
      if (data.ok) resolve(data);
      else reject(new Error(data.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The estimation worker failed."));
    };
    worker.postMessage({ image1, image2, dims, voxel, options });
  });
}

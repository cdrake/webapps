export function createWorkerSession(onProgress) {
  const worker = new Worker(new URL("./lcmodel-worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let id = 0;

  worker.onmessage = ({ data }) => {
    const job = pending.get(data.id);
    if (!job) return;
    if (data.type === "progress") {
      onProgress(data.fraction, data.text);
      return;
    }
    pending.delete(data.id);
    if (data.type === "done") job.resolve(data.result);
    else job.reject(Object.assign(new Error(data.message), { trap: data.name === "RuntimeError" }));
  };
  worker.onerror = (event) => {
    for (const job of pending.values()) job.reject(new Error(event.message || "The processing worker failed."));
    pending.clear();
  };

  return {
    run(job, transfer = []) {
      const jobId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(jobId, { resolve, reject });
        worker.postMessage({ ...job, id: jobId }, transfer);
      });
    },
    terminate() {
      worker.terminate();
      for (const job of pending.values()) job.reject(new DOMException("Cancelled", "AbortError"));
      pending.clear();
    },
  };
}

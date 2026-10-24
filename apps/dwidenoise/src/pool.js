// Spreads a series over a few workers in three passes: the Gram sums of each voxel chunk, then
// one Cholesky solve per volume of each group, then the predictions of each voxel chunk. The
// main thread only gathers chunks, adds partial sums and stores results, so the page stays
// responsive, and a cancel stops the run between two messages.
import { CHUNK_VOXELS } from "@neurodesk/dwidenoise";
import { gatherChunk, scatterChunk, voxelRanges } from "./pipeline.js";

export { CHUNK_VOXELS };

export function workerCount(hardware = globalThis.navigator?.hardwareConcurrency ?? 2) {
  return Math.max(1, Math.min(4, hardware - 1));
}

/**
 * Relative costs of the three passes, in multiply-adds, so that progress moves at about the
 * speed of the work: a Gram chunk adds (n + 1)(n + 2) / 2 products per voxel, a volume solve
 * is a Cholesky factorisation of n - 1 unknowns, and an apply chunk is n² products per voxel.
 */
export function passCosts(groups, nvox) {
  const gram = groups.reduce((sum, group) => sum + ((group.length + 1) * (group.length + 2)) / 2, 0) * nvox;
  const solve = groups.map((group) => (group.length - 1) ** 3 / 3 + group.length ** 2);
  const apply = groups.reduce((sum, group) => sum + group.length ** 2, 0) * nvox;
  return { gram, solve, apply, total: gram + solve.reduce((sum, cost, g) => sum + cost * groups[g].length, 0) + apply };
}

/**
 * Denoises `data` (nvox voxels × frames volumes, volume-major) into `output` (a Float32Array
 * of the same length, for example the data view of the output NIfTI). Returns { data, max }:
 * the output and its largest finite value (-Infinity when there is none), from the workers.
 * The result equals one run of the group solves on the summed Gram matrices: partial sums are
 * added in chunk order, whatever worker answers first.
 * @param groups the fitted volume groups, from fittedGroups(bvals)
 * @param onProgress (fraction, text) after each chunk or volume
 */
export async function denoiseSeries({ data, nvox, frames, groups, output, signal, onProgress }) {
  const out = output ?? new Float32Array(data.length);
  if (out.length !== data.length) throw new Error(`The output holds ${out.length} values, not ${data.length}.`);
  const ranges = voxelRanges(nvox, CHUNK_VOXELS);
  const workers = Array.from({ length: Math.min(workerCount(), ranges.length) }, () =>
    new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
  );
  const costs = passCosts(groups, nvox);
  let done = 0;
  const advance = (cost, text) => onProgress?.((done += cost) / costs.total, text);
  const chunk = (first, count) => gatherChunk(data, nvox, frames, first, count);
  try {
    // Sum the partial Gram matrices in chunk order as they become contiguous, so a run does
    // not depend on which worker answers first and no more parts are held than necessary.
    const grams = [];
    const parts = new Map();
    let next = 0;
    const gramRequest = (first, count) => ({ type: "gram", data: chunk(first, count), count, groups });
    const addGrams = (message, [, count]) => {
      parts.set(message.id, message.grams);
      for (let part = parts.get(next); part; part = parts.get(next)) {
        parts.delete(next++);
        part.forEach((gram, g) => {
          if (!grams[g]) grams[g] = gram;
          else {
            for (let i = 0; i < gram.length; i++) {
              grams[g][i] += gram[i];
            }
          }
        });
      }
      advance((costs.gram * count) / nvox, "Adding Gram sums…");
    };
    await runPass(workers, ranges, signal, gramRequest, addGrams);

    // One message per volume; every worker gets the Gram matrices first.
    const volumes = groups.flatMap((group, g) => group.map((_t, j) => [g, j]));
    const coefficients = groups.map((group) => new Float64Array(group.length * (group.length + 1)));
    const failures = new Map();
    let solved = 0;
    for (const worker of workers) {
      worker.postMessage({ type: "grams", grams, groups });
    }
    const solveRequest = (g, j) => ({ type: "solve", g, j });
    const keepRow = (message, [g, j]) => {
      if (message.failed) failures.set(message.id, message.failed);
      else coefficients[g].set(message.row, j * (groups[g].length + 1));
      advance(costs.solve[g], `Solving volume ${++solved} of ${volumes.length}…`);
    };
    await runPass(workers, volumes, signal, solveRequest, keepRow);
    // Report the first volume that fails in group order, as one serial solve does.
    if (failures.size) throw new Error(failures.get(Math.min(...failures.keys())));

    let max = -Infinity;
    const applyRequest = (first, count) => ({ type: "apply", data: chunk(first, count), count, groups, coefficients });
    const storeChunk = (message, [first, count]) => {
      scatterChunk(out, message.data, nvox, frames, first, count);
      max = Math.max(max, message.max);
      advance((costs.apply * count) / nvox, "Predicting volumes…");
    };
    await runPass(workers, ranges, signal, applyRequest, storeChunk);
    return { data: out, max };
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

/**
 * Gzips `buffer` in a worker and returns the compressed bytes. The buffer is moved to the
 * worker, not copied, so it is detached here afterwards. A cancel stops the worker.
 */
export function gzipInWorker(buffer, signal) {
  const worker = new Worker(new URL("./gzip-worker.js", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const finish = (error, data) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(data);
    };
    const abort = () => finish(signal.reason ?? new DOMException("Denoising cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => finish(new Error(event.message || "The compression worker failed."));
    worker.onmessage = ({ data: message }) => finish(message.error ? new Error(message.error) : null, message.data);
    worker.postMessage({ type: "gzip", buffer }, [buffer]);
  });
}

/**
 * Sends one message per item, one item at a time per worker, until every item has a reply.
 * A cancel rejects at once; the caller then terminates the workers.
 */
function runPass(workers, items, signal, request, receive) {
  return new Promise((resolve, reject) => {
    let next = 0;
    let replies = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      for (const worker of workers) worker.onmessage = worker.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason ?? new DOMException("Denoising cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    const send = (worker) => {
      if (next >= items.length) return;
      const id = next++;
      const message = { id, ...request(...items[id]) };
      worker.postMessage(message, message.data ? [message.data.buffer] : []);
    };
    for (const worker of workers) {
      worker.onerror = (event) => finish(new Error(event.message || "A denoising worker failed."));
      worker.onmessage = ({ data: message }) => {
        if (settled) return;
        if (message.error) return finish(new Error(message.error));
        try {
          receive(message, items[message.id]);
        } catch (error) {
          return finish(error);
        }
        if (++replies === items.length) finish();
        else send(worker);
      };
      send(worker);
    }
  });
}

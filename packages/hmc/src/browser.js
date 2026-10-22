// The web app's runtimes for pipeline.js: @neurodesk/hmc-registration's module worker (one
// kernel each) and CompressionStream for the gzipped series. The kernel is linked with
// -pthread, so the page must be cross-origin isolated (COOP same-origin, COEP require-corp).
import { loadHmc } from "./wasm.js";

/** Loads hmc.wasm from `url` (the bundler's URL of @neurodesk/hmc/hmc.wasm). */
export function loadHmcBrowser(url) {
  return loadHmc(fetch(url).then((response) => {
    if (!response.ok) throw new Error(`hmc.wasm did not load (HTTP ${response.status}).`);
    return response;
  }));
}

/** gzip through the browser's CompressionStream. */
export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The runtime correctHeadMotion takes, on Web Workers.
 * @param {object} options
 * @param {string | URL} options.workerUrl the bundler's URL of @neurodesk/hmc-registration/worker
 * @param {number} [options.workers] worker count (default: hardwareConcurrency, at most 4)
 * @param {{ module: string, wasm: string }} [options.kernel] kernel URLs when a bundler moved them
 */
export function browserRuntime({ workerUrl, workers, kernel } = {}) {
  if (!workerUrl) throw new Error("browserRuntime needs the URL of @neurodesk/hmc-registration/worker.");
  const count = workers ?? Math.max(1, Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1));
  return { spawn: () => new Worker(workerUrl, { type: "module" }), workers: count, gzip, kernel };
}

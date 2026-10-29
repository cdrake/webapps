// A module worker that runs the single-threaded Greedy build (wasm-single/), the bytes the Node
// command lines run, so a browser and Node give the same matrix. Serve src/ beside wasm-single/.
//   in:  { id, method: 'affine' | 'rigid', fixed, moving, wasm? }   raw .nii bytes; wasm: moved .wasm URL
//   out: { id, matrix, heapBytes } | { id, error, heapBytes }
import init, * as api from "../wasm-single/greedy_rs_wasm.js";
import { registerAffineGreedy, registerRigidGreedy } from "./index.js";

const METHODS = { affine: registerAffineGreedy, rigid: registerRigidGreedy };
let ready = null;

self.onmessage = async ({ data: { id, method, fixed, moving, wasm } }) => {
  let exports = null;
  try {
    ready ??= init(wasm ? { module_or_path: wasm } : undefined);
    exports = await ready;
    const register = METHODS[method];
    if (!register) throw new Error(`Unknown Greedy method ${method}.`);
    const matrix = register({ api, fixed, moving });
    self.postMessage({ id, matrix, heapBytes: exports.memory.buffer.byteLength });
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error), heapBytes: exports?.memory.buffer.byteLength ?? null });
  }
};

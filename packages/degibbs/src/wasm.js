// Glue for ./degibbs.wasm (exes/dwi/degibbs-wasm): a plain C ABI, no wasm-bindgen.

/** MRtrix mrdegibbs defaults. */
export const DEFAULTS = Object.freeze({ nshifts: 20, minW: 1, maxW: 3, axes: [0, 1] });

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadDegibbs(source) {
  const wasm = await instantiate(await source);

  /**
   * Removes Gibbs ringing from every slice of `frames` volumes.
   * @param data Float32Array of dims[0] × dims[1] × dims[2] × frames values, first index fastest
   * @param options.axes the two in-plane axes among 0, 1 and 2
   * @returns {Float32Array} the corrected voxels, in the same order
   */
  function degibbs(data, dims, frames = 1, options = {}) {
    const { nshifts, minW, maxW, axes } = { ...DEFAULTS, ...options };
    const length = dims[0] * dims[1] * dims[2] * frames;
    if (data.length !== length) throw new Error(`Expected ${length} voxels, received ${data.length}.`);
    const bytes = length * 4;
    const input = wasm.alloc(bytes);
    const output = wasm.alloc(bytes);
    try {
      new Float32Array(wasm.memory.buffer, input, length).set(data);
      const status = wasm.degibbs(input, dims[0], dims[1], dims[2], frames, axes[0], axes[1], nshifts, minW, maxW, output);
      if (status !== 0) throw new Error("Choose two different in-plane axes and minW below maxW.");
      return new Float32Array(wasm.memory.buffer, output, length).slice();
    } finally {
      wasm.dealloc(output, bytes);
      wasm.dealloc(input, bytes);
    }
  }

  return { degibbs };
}

/**
 * The in-plane axes for a BIDS SliceEncodingDirection (i, j or k, with an optional minus), as
 * mrdegibbs chooses them; [0, 1] when the sidecar has none.
 */
export function sliceAxes(sliceEncodingDirection) {
  const axis = { i: 0, j: 1, k: 2 }[String(sliceEncodingDirection ?? "k").replace("-", "")];
  if (axis === undefined) throw new Error(`Unknown SliceEncodingDirection ${sliceEncodingDirection}.`);
  return [0, 1, 2].filter((a) => a !== axis);
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}

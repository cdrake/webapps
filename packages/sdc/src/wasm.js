// Glue for ./sdc.wasm (exes/sdc/wasm): a plain C ABI, no wasm-bindgen.

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadSdc(source) {
  const wasm = await instantiate(await source);

  /**
   * Estimates the susceptibility field from two b0 volumes with opposite phase-encoding
   * directions (PyHySCO 0.0.4 defaults).
   * @param image1 Float64Array of dims[0] × dims[1] × dims[2] values, first index fastest
   * @param image2 the same size, aligned to image1, with the opposite direction
   * @param voxel voxel sizes in mm (the affine's column lengths)
   * @param options.phaseEncodingDirection image 1's BIDS PhaseEncodingDirection: i, i-, j or j-
   * @param options.totalReadoutTime image 1's TotalReadoutTime in seconds
   * @returns {{ field: Float64Array, corrected1: Float64Array, corrected2: Float64Array, iterations: number }}
   *   the field in Hz (topup's sign) and the two corrected images (normalized), in the input order
   */
  function pyhysco(image1, image2, dims, voxel, options) {
    const { axis, sign } = phaseEncoding(options.phaseEncodingDirection);
    const length = dims[0] * dims[1] * dims[2];
    for (const image of [image1, image2]) {
      if (image.length !== length) throw new Error(`Expected ${length} voxels, received ${image.length}.`);
    }
    const trt = Number(options.totalReadoutTime);
    if (!(trt > 0)) throw new Error("TotalReadoutTime must be a positive number of seconds.");
    const bytes = length * 8;
    const pointers = Array.from({ length: 5 }, () => wasm.alloc(bytes));
    const [in1, in2, field, out1, out2] = pointers;
    try {
      new Float64Array(wasm.memory.buffer, in1, length).set(image1);
      new Float64Array(wasm.memory.buffer, in2, length).set(image2);
      const iterations = wasm.pyhysco(in1, in2, dims[0], dims[1], dims[2], voxel[0], voxel[1], voxel[2], axis, sign, trt, field, out1, out2);
      if (iterations === 0) throw new Error("PyHySCO refused the input: images need finite intensities, a nonzero common intensity range, positive voxel sizes and at least 3 voxels per axis.");
      const read = (pointer) => new Float64Array(wasm.memory.buffer, pointer, length).slice();
      return { field: read(field), corrected1: read(out1), corrected2: read(out2), iterations };
    } finally {
      for (const pointer of pointers) wasm.dealloc(pointer, bytes);
    }
  }

  return { pyhysco };
}

/**
 * The axis (0 for i, 1 for j) and sign of a BIDS PhaseEncodingDirection. PyHySCO needs an
 * in-plane direction, so k is refused.
 */
export function phaseEncoding(code) {
  const text = String(code ?? "");
  const axis = { i: 0, j: 1 }[text.replace(/-$/, "")];
  if (axis === undefined) throw new Error(`PhaseEncodingDirection must be i, i-, j or j-, not "${text}".`);
  return { axis, sign: text.endsWith("-") ? -1 : 1 };
}

/** True when two BIDS PhaseEncodingDirection values are opposite directions on one axis. */
export function isReversePair(first, second) {
  const a = phaseEncoding(first);
  const b = phaseEncoding(second);
  return a.axis === b.axis && a.sign !== b.sign;
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}

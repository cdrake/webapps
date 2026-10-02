export const N4_DEFAULTS = Object.freeze({
  shrink: 2,
  fwhm: 0.15,
  tolerance: 0.001,
  splineOrder: 3,
  noise: 0.01,
  iterations: 50,
  levels: 4,
  controlPoints: 4,
  histogramBins: 200,
});

export function createN4Corrector(module) {
  return function correctBiasField({ data, mask, shape, resolution }, settings = {}) {
    const options = { ...N4_DEFAULTS, ...settings };
    const count = shape?.reduce((a, b) => a * b, 1);
    if (!Array.isArray(shape) || shape.length !== 3 || shape.some((n) => !Number.isInteger(n) || n < 1)
      || !(data instanceof Float32Array) || data.length !== count
      || !Array.isArray(resolution) || resolution.length !== 3
      || resolution.some((n) => !Number.isFinite(n) || n <= 0)
      || (mask != null && (!(mask instanceof Uint8Array) || mask.length !== count))) {
      throw new Error('N4 requires a float32 3D image, positive voxel spacing, and a matching uint8 mask.');
    }
    for (const name of ['shrink', 'splineOrder', 'iterations', 'levels', 'controlPoints', 'histogramBins']) {
      if (!Number.isInteger(options[name]) || options[name] < 1) {
        throw new Error(`N4 ${name} must be a positive integer.`);
      }
    }
    if (options.controlPoints <= options.splineOrder || shape.some((n) => Math.floor(n / options.shrink) < 1)) {
      throw new Error('N4 control points must exceed spline order and shrinking must preserve each dimension.');
    }
    for (const name of ['fwhm', 'tolerance', 'noise']) {
      if (!Number.isFinite(options[name]) || options[name] <= 0) {
        throw new Error(`N4 ${name} must be positive.`);
      }
    }
    if (data.some((n) => !Number.isFinite(n))) throw new Error('N4 input contains non-finite intensities.');
    if (mask && !mask.some((value) => value > 0)) throw new Error('N4 mask contains no selected voxels.');
    const allocations = [];
    const allocate = (bytes) => {
      const pointer = module._malloc(bytes);
      if (!pointer) throw new Error('Insufficient WebAssembly memory for N4.');
      allocations.push(pointer);
      return pointer;
    };
    try {
      const inputPointer = allocate(count * 4);
      const outputPointer = allocate(count * 4);
      const maskPointer = mask ? allocate(count) : 0;
      const shapePointer = allocate(12);
      const spacingPointer = allocate(24);
      const optionsPointer = allocate(72);
      module.HEAPF32.set(data, inputPointer / 4);
      if (mask) module.HEAPU8.set(mask.map((value) => value > 0 ? 1 : 0), maskPointer);
      module.HEAPU32.set(shape, shapePointer / 4);
      module.HEAPF64.set(resolution, spacingPointer / 8);
      module.HEAPF64.set([
        options.shrink, options.fwhm, options.tolerance, options.splineOrder,
        options.noise, options.iterations, options.levels, options.controlPoints, options.histogramBins,
      ], optionsPointer / 8);
      const status = module._n4_correct(inputPointer, maskPointer, outputPointer, shapePointer, spacingPointer, optionsPointer);
      if (status !== 0) throw new Error(`N4 failed: ${module.UTF8ToString(module._n4_error())}`);
      return module.HEAPF32.slice(outputPointer / 4, outputPointer / 4 + count);
    } finally {
      for (const pointer of allocations) module._free(pointer);
    }
  };
}

const f32 = Math.fround;
const product = (values) => values.reduce((a, b) => a * b, 1);
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

export function checkedSize(dims, maxVoxels = 16_777_216) {
  const size = product(dims);
  if (dims.some((d) => !Number.isSafeInteger(d) || d < 1) || !Number.isSafeInteger(size) || size > maxVoxels) {
    throw new Error(`Output support grid exceeds the configured limit of ${maxVoxels} voxels.`);
  }
  return size;
}

function roundEven(value) {
  const lower = Math.floor(value);
  const remainder = value - lower;
  return remainder === 0.5 ? lower + (lower % 2) : Math.round(value);
}

function erf(value) {
  let term = value;
  let sum = term;
  for (let n = 1; n < 100; n++) {
    term *= -value * value / n;
    const delta = term / (2 * n + 1);
    sum += delta;
    if (Math.abs(delta) < 1e-17) break;
  }
  return 2 * sum / Math.sqrt(Math.PI);
}

// NeSVoR utils/misc.py integrates the Gaussian over each voxel. It does not
// normalize the truncated kernel or reflect/replicate values at the boundary.
export function supportGaussianKernel(sigma) {
  if (!(sigma >= 1) || !Number.isFinite(sigma)) throw new Error('Support-mask sigma must be finite and at least one.');
  const tail = Math.floor(Math.max(sigma * 3, 0.5) + 0.5);
  const kernel = new Float32Array(2 * tail + 1);
  const t = f32(0.70710678 / sigma);
  for (let i = -tail; i <= tail; i++) {
    const upper = f32(erf(f32(t * (i + 0.5))));
    const lower = f32(erf(f32(t * (i - 0.5))));
    kernel[i + tail] = Math.max(0, f32(0.5 * f32(upper - lower)));
  }
  return kernel;
}

/** points are packed learned-pose world coordinates in mm. resolutions contains
 * one xyz triplet per slice, not per voxel. Both follow PointDataset.mask. */
export function supportHistogram(points, resolutions, { maxVoxels } = {}) {
  if (!points.length || points.length % 3 || !resolutions.length || resolutions.length % 3) throw new Error('Support construction requires world points and per-slice xyz resolutions.');
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let resolutionMin = Infinity;
  let resolutionMax = 0;
  let logSum = 0;
  for (const value of resolutions) {
    if (!(value > 0) || !Number.isFinite(value)) throw new Error('Slice resolutions must be finite and positive.');
    resolutionMin = Math.min(resolutionMin, f32(value));
    resolutionMax = Math.max(resolutionMax, f32(value));
    logSum += f32(Math.log(f32(value)));
  }
  for (let i = 0; i < points.length; i++) {
    const value = f32(points[i]);
    if (!Number.isFinite(value)) throw new Error('Support points must be finite.');
    minimum[i % 3] = Math.min(minimum[i % 3], value);
    maximum[i % 3] = Math.max(maximum[i % 3], value);
  }
  const padding = f32(resolutionMax * 10);
  const origin = minimum.map((v) => f32(v - padding));
  const dims = origin.map((v, i) => Math.ceil(f32(f32(f32(maximum[i] + padding) - v) / resolutionMin)));
  const histogram = new Float32Array(checkedSize(dims, maxVoxels));
  let occupied = 0;
  for (let i = 0; i < points.length; i += 3) {
    const voxel = origin.map((v, axis) => roundEven(f32(f32(f32(points[i + axis]) - v) / resolutionMin)));
    const index = voxel[0] + dims[0] * (voxel[1] + dims[1] * voxel[2]);
    if (histogram[index] === 0) occupied++;
    histogram[index]++;
  }
  const geometricMean = f32(Math.exp(f32(logSum / resolutions.length)));
  const threshold = f32(f32(f32(resolutionMin ** 3) / f32(geometricMean ** 3)) * f32((points.length / 3) / occupied));
  const affine = [[resolutionMin, 0, 0, origin[0]], [0, resolutionMin, 0, origin[1]], [0, 0, resolutionMin, origin[2]], [0, 0, 0, 1]];
  return { histogram, dims, affine, resolution: [resolutionMin, resolutionMin, resolutionMin], threshold, sigma: f32(resolutionMax / resolutionMin), occupied };
}

/** Replace this callback with a GPU separable convolution without changing the
 * histogram, threshold or world-coordinate contract. */
export async function blurSupport(histogram, dims, sigma, { signal } = {}) {
  const kernel = supportGaussianKernel(sigma);
  const radius = (kernel.length - 1) / 2;
  let input = histogram;
  for (const axis of [2, 1, 0]) {
    const output = new Float32Array(input.length);
    const stride = axis === 0 ? 1 : axis === 1 ? dims[0] : dims[0] * dims[1];
    for (let index = 0; index < input.length; index++) {
      const coordinate = Math.floor(index / stride) % dims[axis];
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        if (coordinate + k >= 0 && coordinate + k < dims[axis]) sum += input[index + k * stride] * kernel[k + radius];
      }
      output[index] = sum;
      if (index % 65_536 === 0) {
        signal?.throwIfAborted();
        await pause();
      }
    }
    input = output;
  }
  return input;
}

export async function buildSupportMask(points, resolutions, { convolve = blurSupport, signal, maxVoxels } = {}) {
  signal?.throwIfAborted();
  const grid = supportHistogram(points, resolutions, { maxVoxels });
  const blurred = await convolve(grid.histogram, grid.dims, grid.sigma, { signal });
  if (blurred.length !== grid.histogram.length) throw new Error('Support convolution returned a different grid size.');
  const mask = new Uint8Array(blurred.length);
  const data = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!Number.isFinite(blurred[i])) throw new Error('Support convolution returned non-finite occupancy.');
    data[i] = mask[i] = blurred[i] > grid.threshold ? 1 : 0;
  }
  signal?.throwIfAborted();
  return { dims: grid.dims, resolution: grid.resolution, affine: grid.affine, data, mask, threshold: grid.threshold };
}

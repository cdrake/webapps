import { volumeSampler, voxelWorld } from '../output/index.js';

const f32 = Math.fround;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

export function thresholdMask(data, mask, threshold = 0) {
  if (!Number.isFinite(threshold) || mask.length !== data.length) throw new Error('Invalid background threshold or mask dimensions.');
  return Uint8Array.from(mask, (value, i) => value && data[i] > threshold ? 1 : 0);
}

export function otsuThreshold(data, bins = 256) {
  if (!data.length || !Number.isSafeInteger(bins) || bins < 2) throw new Error('Otsu thresholding requires a nonempty image and at least two bins.');
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of data) {
    if (!Number.isFinite(value)) throw new Error('Otsu thresholding requires finite intensities.');
    minimum = Math.min(minimum, f32(value));
    maximum = Math.max(maximum, f32(value));
  }
  if (minimum === maximum) throw new Error('Otsu thresholding requires at least two intensity classes.');
  const edges = Float32Array.from({ length: bins + 1 }, (_, i) => minimum + (maximum - minimum) * i / bins);
  const histogram = new Float32Array(bins);
  const centers = Float32Array.from({ length: bins }, (_, i) => f32(edges[i] + edges[i + 1]) / 2);
  for (const value of data) {
    let index = Math.min(bins - 1, Math.floor((value - minimum) * bins / (maximum - minimum)));
    while (index > 0 && value < edges[index]) index--;
    while (index < bins - 1 && value >= edges[index + 1]) index++;
    histogram[index]++;
  }
  if (histogram.filter((count) => count > 0).length < 2) throw new Error('Otsu thresholding requires at least two populated histogram bins.');
  let totalMoment = 0;
  for (let i = 0; i < bins; i++) totalMoment += histogram[i] * centers[i];
  let lowerCount = 0;
  let lowerMoment = 0;
  let best = -Infinity;
  let threshold = centers[0];
  for (let i = 0; i < bins - 1; i++) {
    lowerCount += histogram[i];
    lowerMoment += histogram[i] * centers[i];
    const upperCount = data.length - lowerCount;
    if (!lowerCount || !upperCount) continue;
    const difference = lowerMoment / lowerCount - (totalMoment - lowerMoment) / upperCount;
    const variance = lowerCount * upperCount * difference * difference;
    if (variance > best) {
      best = variance;
      threshold = centers[i];
    }
  }
  return threshold;
}

export async function dilateBall(mask, dims, { radius = 3, signal } = {}) {
  if (!Number.isSafeInteger(radius) || radius < 0 || dims.reduce((a, b) => a * b, 1) !== mask.length) throw new Error('Invalid dilation radius or dimensions.');
  const offsets = [];
  for (let z = -radius; z <= radius; z++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) if (x * x + y * y + z * z <= radius * radius) offsets.push([x, y, z]);
    }
  }
  const output = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) {
      const x = index % dims[0];
      const y = Math.floor(index / dims[0]) % dims[1];
      const z = Math.floor(index / (dims[0] * dims[1]));
      for (const [dx, dy, dz] of offsets) {
        if (x + dx >= 0 && x + dx < dims[0] && y + dy >= 0 && y + dy < dims[1] && z + dz >= 0 && z + dz < dims[2]) output[x + dx + dims[0] * (y + dy + dims[1] * (z + dz))] = 1;
      }
    }
    if (index % 65_536 === 0) {
      signal?.throwIfAborted();
      await pause();
    }
  }
  return output;
}

export async function otsuMask(stack, options = {}) {
  const threshold = otsuThreshold(stack.data, options.bins ?? 256);
  const foreground = Uint8Array.from(stack.data, (value) => value > threshold ? 1 : 0);
  const dilated = await dilateBall(foreground, stack.dims, options);
  return { threshold, mask: Uint8Array.from(stack.mask, (value, i) => value && dilated[i] ? 1 : 0) };
}

export async function intersectMasks(volumes, { box = true, signal } = {}) {
  if (!volumes.length) throw new Error('Stack intersection needs at least one volume.');
  const reference = volumes[0];
  const mask = Uint8Array.from(reference.mask);
  for (const volume of volumes.slice(1)) {
    const sample = volumeSampler({ ...volume, data: Float32Array.from(volume.mask) });
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) mask[i] = sample(voxelWorld(reference, i)) > 0 ? 1 : 0;
      if (i % 65_536 === 0) {
        signal?.throwIfAborted();
        await pause();
      }
    }
  }
  if (!mask.some((v) => v)) throw new Error('The intersection of inputs is empty.');
  if (box) {
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const p = [i % reference.dims[0], Math.floor(i / reference.dims[0]) % reference.dims[1], Math.floor(i / (reference.dims[0] * reference.dims[1]))];
      p.forEach((v, axis) => {
        minimum[axis] = Math.min(minimum[axis], v);
        maximum[axis] = Math.max(maximum[axis], v);
      });
    }
    for (let z = minimum[2]; z <= maximum[2]; z++) {
      for (let y = minimum[1]; y <= maximum[1]; y++) {
        for (let x = minimum[0]; x <= maximum[0]; x++) mask[x + reference.dims[0] * (y + reference.dims[1] * z)] = 1;
      }
    }
  }
  return { ...reference, mask, data: Float32Array.from(mask) };
}

export async function applyVolumeMask(stack, volume, { signal } = {}) {
  const sample = volumeSampler(volume);
  const mask = Uint8Array.from(stack.mask);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) mask[i] = sample(voxelWorld(stack, i)) > 0 ? 1 : 0;
    if (i % 65_536 === 0) {
      signal?.throwIfAborted();
      await pause();
    }
  }
  return { ...stack, mask };
}

export function normalizeStack(stack) {
  const masked = [];
  for (let i = 0; i < stack.data.length; i++) if (stack.mask[i]) masked.push(f32(stack.data[i]));
  if (!masked.length) throw new Error('A stack has no voxels after masking.');
  masked.sort((a, b) => a - b);
  const position = f32(f32(0.99) * (masked.length - 1));
  const lower = Math.floor(position);
  const scale = f32(masked[lower] + f32((masked[Math.min(lower + 1, masked.length - 1)] - masked[lower]) * (position - lower)));
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('The masked 99th intensity percentile must be finite and positive.');
  return { ...stack, data: Float32Array.from(stack.data, (value) => value / scale), intensityScale: scale };
}

export async function preprocessStacks(stacks, { backgroundThreshold = 0, otsuThresholding = false, stacksIntersection = false, volumeMask = null, normalize = true, signal } = {}) {
  let output = stacks.map((stack) => ({ ...stack, data: Float32Array.from(stack.data), mask: thresholdMask(stack.data, stack.mask ?? new Uint8Array(stack.data.length).fill(1), backgroundThreshold) }));
  if (otsuThresholding) {
    for (const stack of output) stack.mask = (await otsuMask(stack, { signal })).mask;
  }
  const mask = volumeMask ?? (stacksIntersection ? await intersectMasks(output, { box: true, signal }) : null);
  if (mask) {
    for (let i = 0; i < output.length; i++) output[i] = await applyVolumeMask(output[i], mask, { signal });
  }
  if (normalize) output = output.map(normalizeStack);
  signal?.throwIfAborted();
  return { stacks: output, volumeMask: mask };
}

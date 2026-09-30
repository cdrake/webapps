import { fetchModel } from '../../../components/src/worker/fetchModel.js';

export function resizePlanes(data, width, height, targetWidth, targetHeight, planes = 1) {
  const result = new Float32Array(targetWidth * targetHeight * planes);
  for (let p = 0; p < planes; p++) {
    for (let y = 0; y < targetHeight; y++) {
      const sy = targetHeight === 1 ? 0 : y * (height - 1) / (targetHeight - 1);
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, height - 1);
      const fy = sy - y0;
      for (let x = 0; x < targetWidth; x++) {
        const sx = targetWidth === 1 ? 0 : x * (width - 1) / (targetWidth - 1);
        const x0 = Math.floor(sx);
        const x1 = Math.min(x0 + 1, width - 1);
        const fx = sx - x0;
        const offset = p * width * height;
        const a = data[offset + y0 * width + x0] * (1 - fx) + data[offset + y0 * width + x1] * fx;
        const b = data[offset + y1 * width + x0] * (1 - fx) + data[offset + y1 * width + x1] * fx;
        result[(p * targetHeight + y) * targetWidth + x] = a * (1 - fy) + b * fy;
      }
    }
  }
  return result;
}

export function prepareStack(stack) {
  const [width, height, count] = stack.shape;
  const resizedWidth = Math.floor(width * stack.resolution[0] / 0.8);
  const resizedHeight = Math.floor(height * stack.resolution[1] / 0.8);
  if (resizedWidth < 1 || resizedHeight < 1) throw new Error('Stack spacing produces an empty segmentation image.');
  const data = resizePlanes(stack.data, width, height, resizedWidth, resizedHeight, count);
  let mean = 0;
  for (const value of data) mean += value;
  mean /= data.length;
  let variance = 0;
  for (const value of data) variance += (value - mean) ** 2;
  const std = Math.sqrt(variance / Math.max(1, data.length - 1));
  for (let i = 0; i < data.length; i++) data[i] = (data[i] - mean) / (std + 1e-8);
  return { data, width: resizedWidth, height: resizedHeight, count };
}

export function augmentationShape(width, height, transpose) {
  const w = transpose ? height : width;
  const h = transpose ? width : height;
  // The pinned NeSVoR wrapper uses height for both padding dimensions.
  const paddedWidth = Math.max(Math.ceil(h / 128), 4) * 128;
  const paddedHeight = Math.max(Math.ceil(h / 64), 7) * 64;
  if (paddedWidth < w) throw new Error('This stack aspect ratio triggers the upstream MONAIfbs negative-padding defect. Crop its in-plane field of view first.');
  return { width: w, height: h, paddedWidth, paddedHeight, left: Math.floor((paddedWidth - w) / 2), top: Math.floor((paddedHeight - h) / 2) };
}

function augmentedIndex(x, y, shape, transpose, flipY, flipX) {
  let ax = transpose ? y : x;
  let ay = transpose ? x : y;
  if (flipX) ax = shape.width - 1 - ax;
  if (flipY) ay = shape.height - 1 - ay;
  return (ay + shape.top) * shape.paddedWidth + ax + shape.left;
}

export function postprocessMask(logits, width, height, count, { radius = 1, thresholdSmall = 0.1, resolution = [0.8, 0.8] } = {}) {
  const area = width * height;
  const mask = new Uint8Array(area * count);
  const dilation = Math.ceil(2 * radius / (resolution[0] + resolution[1]));
  const offsets = [];
  for (let dy = -dilation; dy <= dilation; dy++) {
    for (let dx = -dilation; dx <= dilation; dx++) {
      if (dx * dx + dy * dy <= dilation * dilation) offsets.push([dx, dy]);
    }
  }
  const sizes = new Uint32Array(count);
  for (let z = 0; z < count; z++) {
    const foreground = new Uint8Array(area);
    for (let i = 0; i < area; i++) {
      if (logits[(z * 2 + 1) * area + i] <= logits[z * 2 * area + i]) continue;
      const x = i % width;
      const y = Math.floor(i / width);
      for (const [dx, dy] of offsets) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height) foreground[yy * width + xx] = 1;
      }
    }
    const queue = new Int32Array(area);
    let largest = [];
    for (let i = 0; i < area; i++) {
      if (!foreground[i]) continue;
      let tail = 1;
      queue[0] = i;
      foreground[i] = 0;
      for (let head = 0; head < tail; head++) {
        const x = queue[head] % width;
        const y = Math.floor(queue[head] / width);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            const j = yy * width + xx;
            if (xx >= 0 && xx < width && yy >= 0 && yy < height && foreground[j]) {
              foreground[j] = 0;
              queue[tail++] = j;
            }
          }
        }
      }
      if (tail > largest.length) largest = queue.slice(0, tail);
    }
    sizes[z] = largest.length;
    for (const index of largest) mask[z * area + index] = 1;
  }
  const maximum = sizes.reduce((a, b) => Math.max(a, b), 0);
  for (let z = 0; z < count; z++) {
    if (sizes[z] < thresholdSmall * maximum) mask.fill(0, z * area, (z + 1) * area);
  }
  return mask;
}

export async function segmentStacks(stacks, { infer, signal, augmentation = true, radius = 1, thresholdSmall = 0.1, onProgress = () => {} }) {
  if (typeof infer !== 'function') throw new Error('MONAIfbs inference runtime is required.');
  const result = [];
  for (let stackIndex = 0; stackIndex < stacks.length; stackIndex++) {
    signal?.throwIfAborted();
    const stack = stacks[stackIndex];
    const image = prepareStack(stack);
    const area = image.width * image.height;
    const sum = new Float32Array(image.count * 2 * area);
    const transforms = augmentation ? [true, false] : [false];
    const flips = augmentation ? [[false, false], [true, false], [false, true], [true, true]] : [[false, false]];
    let completed = 0;
    const total = image.count * transforms.length * flips.length;
    onProgress({ stage: 'segmentation', stack: stackIndex, stacks: stacks.length, completed, total });
    for (const transpose of transforms) {
      const shape = augmentationShape(image.width, image.height, transpose);
      const paddedArea = shape.paddedWidth * shape.paddedHeight;
      for (const [flipY, flipX] of flips) {
        for (let z = 0; z < image.count; z++) {
          signal?.throwIfAborted();
          const input = new Float32Array(paddedArea);
          for (let y = 0; y < image.height; y++) {
            for (let x = 0; x < image.width; x++) input[augmentedIndex(x, y, shape, transpose, flipY, flipX)] = image.data[z * area + y * image.width + x];
          }
          const logits = await infer(input, [1, 1, shape.paddedHeight, shape.paddedWidth]);
          if (logits.length !== 2 * paddedArea) throw new Error('MONAIfbs returned an unexpected output shape.');
          for (let channel = 0; channel < 2; channel++) {
            for (let y = 0; y < image.height; y++) {
              for (let x = 0; x < image.width; x++) sum[(z * 2 + channel) * area + y * image.width + x] += logits[channel * paddedArea + augmentedIndex(x, y, shape, transpose, flipY, flipX)];
            }
          }
          onProgress({ stage: 'segmentation', stack: stackIndex, stacks: stacks.length, slice: z, completed: ++completed, total, transpose, flipY, flipX });
        }
      }
    }
    const [width, height, count] = stack.shape;
    const logits = resizePlanes(sum, image.width, image.height, width, height, count * 2);
    const mask = postprocessMask(logits, width, height, count, { radius, thresholdSmall, resolution: stack.resolution });
    for (let i = 0; i < mask.length; i++) mask[i] &= stack.mask[i];
    result.push({ ...stack, mask });
  }
  return result;
}

export async function createMaskInference({ runtime, manifest, baseUrl = manifest?.base_url, signal, executionProviders = ['wasm'], onProgress }) {
  if (manifest?.source_commit !== '730ddaa3711a2304386de34193ea4b957892fe7b' || !/^[a-f0-9]{64}$/.test(manifest?.sha256 ?? '')) throw new Error('Invalid pinned MONAIfbs manifest.');
  const bytes = await fetchModel({ url: new URL(manifest.file, baseUrl).href, integrity: { sha256: manifest.sha256, bytes: manifest.bytes } }, { signal, onProgress });
  signal?.throwIfAborted();
  onProgress?.({ stage: 'segmentation-model-init' });
  const session = await runtime.InferenceSession.create(bytes, { executionProviders, graphOptimizationLevel: 'all' });
  if (signal?.aborted) {
    await session.release();
    signal.throwIfAborted();
  }
  onProgress?.({ stage: 'segmentation-backend', message: `Brain masking backend: ${executionProviders.join(', ')}` });
  let firstInference = true;
  const infer = async (data, dimensions) => {
    signal?.throwIfAborted();
    const input = new runtime.Tensor('float32', data, dimensions);
    let output;
    try {
      if (firstInference && executionProviders.includes('webgpu')) {
        onProgress?.({ stage: 'segmentation-warmup' });
      }
      output = await session.run({ image: input });
      firstInference = false;
      signal?.throwIfAborted();
      return Float32Array.from(output.logits.data);
    } finally {
      input.dispose();
      Object.values(output ?? {}).forEach((tensor) => tensor.dispose());
    }
  };
  infer.release = () => session.release();
  return infer;
}

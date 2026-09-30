import { axisAngleToMatrix, matrixToAxisAngle, mapTransforms, meanTransform, compose, inverse } from './geometry.js';
import { resample, percentile, makePSF, nccLoss } from './resampling.js';
import { createAcquisition, reconstructCG } from './acquisition.js';
import { runSvortIterations } from './svort.js';
import { registerStackCandidates } from './stack-registration.js';

export { createOnnxLearnedStep } from './onnx.js';

function validateStack(stack) {
  if (!Array.isArray(stack.shape) || stack.shape.length !== 3 || stack.shape.some((n) => !Number.isInteger(n) || n < 1)) throw new Error('Registration requires a three-dimensional stack.');
  const length = stack.shape.reduce((a, b) => a * b, 1);
  if (stack.data.length !== length || stack.mask.length !== length || stack.transforms.length !== stack.shape[2] * 12) throw new Error('Stack data, mask and slice transforms do not agree.');
  if (stack.resolution.some((v) => !Number.isFinite(v) || v <= 0) || !Number.isFinite(stack.thickness) || stack.thickness <= 0) throw new Error('Registration requires positive physical resolutions.');
  if (!stack.data.every(Number.isFinite) || !stack.transforms.every(Number.isFinite)) throw new Error('Registration inputs contain non-finite values.');
}

export function prepareRegistration(stacks, { onProgress = () => {} } = {}) {
  const records = [];
  for (let stackIndex = 0; stackIndex < stacks.length; stackIndex++) {
    const original = stacks[stackIndex];
    validateStack(original);
    const masked = Float64Array.from(original.data, (v, i) => original.mask[i] ? v : 0);
    const sampled = resample(masked, original.shape, original.resolution, [1, 1, original.resolution[2]]);
    const [nx, ny, nz] = sampled.shape;
    let biggest = 0;
    let biggestCount = -1;
    for (let z = 0; z < nz; z++) {
      let count = 0;
      for (let i = z * nx * ny; i < (z + 1) * nx * ny; i++) if (sampled.data[i] > 0) count++;
      if (count > biggestCount) {
        biggest = z;
        biggestCount = count;
      }
    }
    let top = 0;
    let bottom = ny - 1;
    let left = 0;
    let right = nx - 1;
    const rowSum = (y) => sampled.data.subarray((biggest * ny + y) * nx, (biggest * ny + y + 1) * nx).reduce((sum, v) => sum + v, 0);
    const columnSum = (x) => Array.from({ length: ny }, (_, y) => sampled.data[(biggest * ny + y) * nx + x]).reduce((sum, v) => sum + v, 0);
    while (top < ny && rowSum(top) === 0) top++;
    while (bottom && rowSum(bottom) === 0) bottom--;
    while (left < nx && columnSum(left) === 0) left++;
    while (right && columnSum(right) === 0) right--;
    if (bottom - top <= 0) continue;
    if (bottom - top > 128 || right - left > 128) onProgress({ stage: 'registration-warning', message: `Stack ${stackIndex + 1} region exceeds SVoRT's 128 mm crop.` });
    const centerX = Math.floor((left + right) / 2);
    const centerY = Math.floor((top + bottom) / 2);
    const cropped = new Float64Array(128 * 128 * nz);
    let first = nz;
    let last = -1;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < 128; y++) {
        for (let x = 0; x < 128; x++) {
          const sx = centerX - 64 + x;
          const sy = centerY - 64 + y;
          const value = sx >= 0 && sy >= 0 && sx < nx && sy < ny ? sampled.data[(z * ny + sy) * nx + sx] : 0;
          cropped[(z * 128 + y) * 128 + x] = value;
          if (value > 0) {
            first = Math.min(first, z);
            last = Math.max(last, z);
          }
        }
      }
    }
    if (last < first) continue;
    const data = cropped.slice(first * 128 * 128, (last + 1) * 128 * 128);
    const scale = percentile(data.filter((v) => v > 0), 0.99);
    for (let i = 0; i < data.length; i++) data[i] /= scale;
    const poses = Array.from({ length: nz }, (_, z) => matrixToAxisAngle(original.transforms.subarray(z * 12, z * 12 + 12)));
    const meanZ = poses.slice(first, last + 1).reduce((sum, pose) => sum + pose[5], 0) / (last - first + 1);
    const reset = Float64Array.from(poses.flatMap((pose) => Array.from(axisAngleToMatrix([0, 0, 0, -(centerX - nx / 2), -(centerY - ny / 2), pose[5] - meanZ]))));
    const cropTransforms = Float64Array.from(poses.slice(first, last + 1).flatMap((pose) => Array.from(axisAngleToMatrix([0, 0, 0, 0, 0, pose[5] - meanZ]))));
    const common = { ...original, resolution: [1, 1, original.resolution[2]] };
    const full = { ...common, data: sampled.data, mask: Uint8Array.from(sampled.data, (v) => v > 0), shape: sampled.shape };
    records.push({ original, stackIndex, first, last,
      cropped: { ...common, data, mask: Uint8Array.from(data, (v) => v > 0), shape: [128, 128, last - first + 1], transforms: cropTransforms },
      full,
      reset: { ...full, transforms: reset },
    });
  }
  if (!records.length) throw new Error('All registration stacks are empty after masking.');
  const thickness = records.reduce((sum, record) => sum + record.original.thickness, 0) / records.length;
  for (const record of records) for (const key of ['cropped', 'full', 'reset']) record[key].thickness = thickness;
  return { records, ...makePSF([1 / 0.8, 1 / 0.8, thickness / 0.8]) };
}

export function transformDifferences(output, input) {
  const differences = mapTransforms(output, (matrix, i) => compose(matrix, inverse(input.subarray(i * 12, i * 12 + 12))));
  const count = differences.length / 12;
  const middle = Math.floor(count / 2);
  const mean = meanTransform(differences.subarray(Math.max(0, middle - 3) * 12, Math.min(count, middle + 3) * 12), { robust: true });
  return { differences, mean };
}

function operatorFor(stack, psf, psfShape, volumeShape) {
  return createAcquisition({
    transforms: stack.transforms.map((v, i) => i % 4 === 3 ? v / 0.8 : v),
    volumeShape, sliceShape: stack.shape.slice(0, 2), resolution: 1 / 0.8,
    psf, psfShape, sliceMask: stack.mask,
  });
}

function scoreSlices(stack, volume, volumeShape) {
  const { psf, psfShape } = makePSF([1 / 0.8, 1 / 0.8, stack.thickness / 0.8]);
  const simulated = operatorFor(stack, psf, psfShape, volumeShape).forward(volume).data;
  const pixels = stack.shape[0] * stack.shape[1];
  const losses = [];
  const weights = [];
  for (let z = 0; z < stack.shape[2]; z++) {
    const start = z * pixels;
    const mask = stack.mask.subarray(start, start + pixels);
    losses.push(nccLoss(simulated.subarray(start, start + pixels), stack.data.subarray(start, start + pixels), mask));
    weights.push(mask.reduce((sum, v) => sum + Number(Boolean(v)), 0));
  }
  return { losses, weights };
}

export function correctPrediction(output, input, volume, volumeShape) {
  return output.map((stack, i) => {
    const { mean } = transformDifferences(stack.transforms, input[i].transforms);
    const rigid = { ...input[i], transforms: mapTransforms(input[i].transforms, (m) => compose(mean, m)) };
    const rigidScore = scoreSlices(rigid, volume, volumeShape);
    const sliceScore = scoreSlices(stack, volume, volumeShape);
    return { ...stack, transforms: mapTransforms(stack.transforms, (m, z) => sliceScore.losses[z] <= rigidScore.losses[z] ? m : rigid.transforms.subarray(z * 12, z * 12 + 12)) };
  });
}

export function propagateTransforms(output, records) {
  const slices = [];
  const stacks = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const { mean, differences } = transformDifferences(output[i].transforms, record.cropped.transforms);
    const rigid = mapTransforms(record.reset.transforms, (m) => compose(mean, m));
    const full = mapTransforms(record.reset.transforms, (m, z) => z >= record.first && z <= record.last ? compose(differences.subarray((z - record.first) * 12, (z - record.first + 1) * 12), m) : rigid.subarray(z * 12, z * 12 + 12));
    slices.push({ ...record.reset, transforms: full });
    stacks.push({ ...record.reset, transforms: rigid });
  }
  return { slices, stacks };
}

function reconstructCandidate(stacks, psf, psfShape, volumeShape) {
  const size = Math.max(...stacks.flatMap((s) => s.shape.slice(0, 2)));
  const selected = stacks.slice(0, 3);
  const count = selected.reduce((sum, s) => sum + s.shape[2], 0);
  const data = new Float64Array(size * size * count);
  const mask = new Uint8Array(data.length);
  const transforms = new Float64Array(count * 12);
  let offset = 0;
  for (const stack of selected) {
    const [nx, ny, nz] = stack.shape;
    const left = Math.floor((size - nx) / 2);
    const top = Math.floor((size - ny) / 2);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const source = x + nx * (y + ny * z);
      const target = x + left + size * (y + top + size * (z + offset));
      data[target] = stack.data[source];
      mask[target] = stack.mask[source];
    }
    transforms.set(stack.transforms, offset * 12);
    offset += nz;
  }
  const operator = operatorFor({ transforms, shape: [size, size, count], mask }, psf, psfShape, volumeShape);
  return reconstructCG(operator, data, operator.adjoint(data, { equalize: true }).data, { iterations: 1 });
}

function candidateScore(stacks, records, volume, volumeShape) {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < stacks.length; i++) {
    const score = scoreSlices(stacks[i], volume, volumeShape);
    for (let z = records[i].first; z <= records[i].last; z++) {
      numerator -= score.losses[z] * score.weights[z];
      denominator += score.weights[z];
    }
  }
  if (!denominator) throw new Error('Registration candidates have no masked support.');
  return numerator / denominator;
}

export async function registerStacks(stacks, { mode = 'svort', learnedStep, signal, onProgress = () => {}, forceScanner = false, volumeShape = [200, 200, 200], registrationOptions } = {}) {
  if (!['svort', 'svort-only', 'svort-stack', 'stack'].includes(mode)) throw new Error(`Unsupported registration mode: ${mode}`);
  signal?.throwIfAborted();
  const useSvort = mode !== 'stack';
  const useStack = mode !== 'svort-only';
  if (useSvort && typeof learnedStep !== 'function') throw new Error('SVoRT registration requires the verified SVoRTv2 learned subgraphs.');
  const prepared = prepareRegistration(stacks, { onProgress });
  const { records, psf, psfShape } = prepared;
  let sliceCandidate;
  let rigidCandidate;
  let scoreSvort = -Infinity;
  let scoreStack = -Infinity;
  if (useSvort) {
    const input = records.map((record) => record.cropped);
    const count = input.reduce((sum, s) => sum + s.shape[2], 0);
    const data = new Float32Array(count * 128 * 128);
    const transforms = new Float64Array(count * 12);
    const positions = new Float32Array(count * 2);
    let offset = 0;
    input.forEach((stack, i) => {
      data.set(stack.data, offset * 128 * 128);
      transforms.set(stack.transforms, offset * 12);
      for (let z = 0; z < stack.shape[2]; z++) positions.set([z - Math.floor(stack.shape[2] / 2), i], (offset + z) * 2);
      offset += stack.shape[2];
    });
    const prediction = await runSvortIterations({ slices: data, transforms, positions, psf, psfShape, volumeShape }, learnedStep, { signal, onProgress });
    offset = 0;
    const output = input.map((stack) => {
      const result = { ...stack, transforms: prediction.transforms.slice(offset * 12, (offset + stack.shape[2]) * 12) };
      offset += stack.shape[2];
      return result;
    });
    const corrected = correctPrediction(output, input, prediction.volume, volumeShape);
    const propagated = propagateTransforms(corrected, records);
    sliceCandidate = propagated.slices;
    rigidCandidate = propagated.stacks;
    if (useStack) {
      const volume = reconstructCandidate(sliceCandidate, psf, psfShape, volumeShape);
      scoreSvort = candidateScore(sliceCandidate, records, volume, volumeShape);
    } else scoreSvort = Infinity;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  let stackCandidate;
  if (useStack) {
    stackCandidate = await registerStackCandidates(useSvort ? [rigidCandidate, records.map((r) => r.full)] : [records.map((r) => r.full)], { ...registrationOptions, centering: useSvort, signal, onProgress });
    if (useSvort) {
      const volume = reconstructCandidate(stackCandidate, psf, psfShape, volumeShape);
      scoreStack = candidateScore(stackCandidate, records, volume, volumeShape);
    } else scoreStack = Infinity;
  }
  signal?.throwIfAborted();
  const selected = scoreSvort < scoreStack || mode === 'svort-stack' ? 'stack' : 'slice';
  let selectedStacks = selected === 'stack' ? stackCandidate : sliceCandidate;
  if (forceScanner) {
    const correction = compose(meanTransform(records[0].full.transforms), inverse(meanTransform(selectedStacks[0].transforms)));
    selectedStacks = selectedStacks.map((s) => ({ ...s, transforms: mapTransforms(s.transforms, (m) => compose(correction, m)) }));
  }
  return {
    stacks: records.map((record, i) => {
      const scale = percentile(Array.from(record.original.data).filter((_, j) => record.original.mask[j]), 0.99);
      if (!(scale > 0)) throw new Error('Registered stack intensity normalization is undefined.');
      return { ...record.original, data: Float32Array.from(record.original.data, (v) => v / scale), transforms: selectedStacks[i].transforms };
    }),
    registration: { mode, selected, scoreSvort: Number.isFinite(scoreSvort) ? scoreSvort : null, scoreStack: Number.isFinite(scoreStack) ? scoreStack : null, sourceCommit: '730ddaa3711a2304386de34193ea4b957892fe7b' },
  };
}

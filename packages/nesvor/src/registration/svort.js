import { createAcquisition, reconstructCG } from './acquisition.js';
import { matrixToPoints, pointsToMatrix } from './geometry.js';

function blurredSupport(slices, width, height) {
  const mask = new Uint8Array(slices.length);
  const pixels = width * height;
  for (let i = 0; i < slices.length; i++) {
    if (!(slices[i] > 0)) continue;
    const x = i % width;
    const y = Math.floor(i / width) % height;
    const base = Math.floor(i / pixels) * pixels;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) mask[base + (y + dy) * width + x + dx] = 1;
      }
    }
  }
  return mask;
}

// Inputs must already have upstream parse_data's 1 mm, 128-square crop and normalization.
// This is the four-iteration model only, not the full svort registration preset.
export async function runSvortIterations({ slices, transforms, positions, psf, psfShape, volumeShape = [200, 200, 200], sliceShape = [128, 128], reconstructionResolution = 0.8, sliceResolution = 1 }, learnedStep, { signal, onProgress = () => {} } = {}) {
  const [width, height] = sliceShape;
  const count = transforms.length / 12;
  const pixels = width * height;
  if (slices.length !== count * pixels || positions.length !== count * 2) throw new Error('SVoRT input dimensions differ.');
  if (!slices.every((v) => Number.isFinite(v) && v >= 0)) throw new Error('SVoRT requires finite nonnegative normalized intensities.');
  let theta = Float32Array.from(Array.from({ length: count }, (_, i) => matrixToPoints(transforms.subarray(i * 12, i * 12 + 12), width, height, sliceResolution)).flat());
  const mask = blurredSupport(slices, width, height);
  let volume;
  let matrices;
  let unmaskedOperator;
  let scores;
  for (let iteration = 0; iteration < 4; iteration++) {
    signal?.throwIfAborted();
    const report = (phase) => onProgress({ stage: 'svort', phase, iteration: iteration + 1, total: 4 });
    report('Projecting slices');
    const estimated = volume ? Float32Array.from(unmaskedOperator.forward(volume).data) : new Float32Array(slices.length);
    report('Estimating motion');
    const prediction = await learnedStep({ iteration, theta, slices, positions, estimated, count, sliceShape, signal });
    signal?.throwIfAborted();
    if (prediction.theta.length !== count * 9 || prediction.score.length !== count || !prediction.theta.every(Number.isFinite) || !prediction.score.every((v) => Number.isFinite(v) && v >= 0 && v <= 3)) throw new Error('Invalid SVoRT learned prediction.');
    theta = prediction.theta;
    scores = prediction.score;
    matrices = Float64Array.from(Array.from({ length: count }, (_, i) => Array.from(pointsToMatrix(theta.subarray(i * 9, i * 9 + 9)))).flat());
    const scaled = matrices.map((v, i) => i % 4 === 3 ? v / reconstructionResolution : v);
    const options = { transforms: scaled, psf, psfShape, volumeShape, sliceShape, resolution: sliceResolution / reconstructionResolution };
    const operator = createAcquisition({ ...options, sliceMask: mask });
    unmaskedOperator = createAcquisition(options);
    report('Backprojecting slices');
    volume = operator.adjoint(slices, { equalize: true }).data;
    const sliceWeights = Float64Array.from({ length: slices.length }, (_, i) => scores[Math.floor(i / pixels)]);
    report('Reconstructing registration volume');
    volume = reconstructCG(operator, slices, volume, { iterations: 2, sliceWeights });
    onProgress({ stage: 'svort', completed: iteration + 1, total: 4 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return { transforms: matrices, volume, theta, scores };
}

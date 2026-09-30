import { axisAngleToMatrix, matrixToAxisAngle, compose, inverse, meanTransform, mapTransforms, stackTransforms } from './geometry.js';
import { gaussianBlur, resample, sampleLinear, nccLoss } from './resampling.js';

function volume(stack) {
  return {
    shape: stack.shape,
    resolution: stack.resolution,
    data: Float64Array.from(stack.data, (v, i) => stack.mask[i] ? v : 0),
    transform: meanTransform(stack.transforms),
  };
}

export async function registerVolume(source, target, { levels = 3, steps = 4, stepSize = 2, maxIterations = 20, signal, onProgress = () => {} } = {}) {
  const resolution = Math.min(...source.resolution, ...target.resolution);
  const initial = compose(inverse(target.transform), source.transform);
  const theta = matrixToAxisAngle(initial);
  const initialTranslation = [0, 1, 2].map((row) => [0, 1, 2].reduce((sum, col) => sum + initial[row * 4 + col] * initial[col * 4 + 3], 0));
  for (let i = 0; i < 3; i++) {
    theta[i] *= 180 / Math.PI;
    theta[i + 3] = initialTranslation[i];
  }
  let loss = Infinity;
  for (let level = levels - 1; level >= 0; level--) {
    signal?.throwIfAborted();
    const spacing = resolution * 2 ** level;
    const prepare = (input) => {
      const filtered = gaussianBlur(input.data, input.shape, input.resolution.map((r) => 0.5 * spacing / r));
      return resample(filtered, input.shape, input.resolution, [spacing, spacing, spacing]);
    };
    const sourceLevel = prepare(source);
    const targetLevel = prepare(target);
    const coordinates = [];
    const targetValues = [];
    for (let i = 0; i < targetLevel.data.length; i++) {
      if (!(targetLevel.data[i] > 0)) continue;
      const p = [i % targetLevel.shape[0], Math.floor(i / targetLevel.shape[0]) % targetLevel.shape[1], Math.floor(i / (targetLevel.shape[0] * targetLevel.shape[1]))];
      coordinates.push(p.map((v, axis) => (v - (targetLevel.shape[axis] - 1) / 2) * spacing));
      targetValues.push(targetLevel.data[i]);
    }
    if (!coordinates.length) throw new Error('Registration target is empty after resampling.');
    const warped = new Float64Array(coordinates.length);
    const evaluate = (parameters) => {
      const matrix = axisAngleToMatrix([...parameters.slice(0, 3).map((v) => v * Math.PI / 180), 0, 0, 0]);
      for (let i = 0; i < coordinates.length; i++) {
        const sourcePoint = [0, 1, 2].map((axis) => [0, 1, 2].reduce((sum, row) => sum + matrix[row * 4 + axis] * (coordinates[i][row] - parameters[row + 3]), 0) / spacing + (sourceLevel.shape[axis] - 1) / 2);
        warped[i] = sampleLinear(sourceLevel.data, sourceLevel.shape, sourcePoint);
      }
      return nccLoss(warped, targetValues);
    };
    let momentum;
    for (let step = 0; step < steps; step++) {
      const distance = stepSize * 2 ** level / 2 ** step;
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        signal?.throwIfAborted();
        loss = evaluate(theta);
        const gradient = theta.map((value, axis) => {
          const plus = [...theta];
          const minus = [...theta];
          plus[axis] = value + distance;
          minus[axis] = value - distance;
          return evaluate(plus) - evaluate(minus);
        });
        momentum = gradient.map((v, i) => v + 0.1 * (momentum?.[i] ?? 0));
        const norm = Math.hypot(...momentum) + 1e-6;
        const candidate = theta.map((v, i) => v - distance * momentum[i] / norm);
        const nextLoss = evaluate(candidate);
        if (!(nextLoss + 1e-4 < loss)) break;
        theta.splice(0, 6, ...candidate);
        onProgress({ stage: 'stack-registration', level, step, iteration, loss: nextLoss });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  const matrix = axisAngleToMatrix([...theta.slice(0, 3).map((v) => v * Math.PI / 180), 0, 0, 0]);
  for (let i = 0; i < 3; i++) matrix[i * 4 + 3] = [0, 1, 2].reduce((sum, row) => sum + matrix[row * 4 + i] * theta[row + 3], 0);
  return { transform: compose(target.transform, matrix), loss };
}

export async function registerStackCandidates(candidates, { centering = false, ...options } = {}) {
  const target = volume(candidates[0][0]);
  const sourceVolumes = candidates.map((stacks) => stacks.map(volume));
  const selected = [];
  const registered = [];
  for (let stack = 0; stack < candidates[0].length; stack++) {
    options.signal?.throwIfAborted();
    if (stack === 0) {
      selected.push(candidates[0][0]);
      registered.push(target.transform);
      continue;
    }
    let best;
    for (let candidate = 0; candidate < candidates.length; candidate++) {
      const source = sourceVolumes[candidate][stack];
      source.transform = compose(compose(registered[0], inverse(sourceVolumes[candidate][0].transform)), source.transform);
      const result = await registerVolume(source, target, options);
      if (!best || result.loss < best.loss) best = { ...result, stack: candidates[candidate][stack] };
    }
    registered.push(best.transform);
    selected.push(best.stack);
  }
  const targetCenter = [0, 1, 2].map((row) => -[0, 1, 2].reduce((sum, col) => sum + registered[0][row * 4 + col] * registered[0][col * 4 + 3], 0));
  const center = axisAngleToMatrix([0, 0, 0, ...targetCenter]);
  return selected.map((stack, i) => ({
    ...stack,
    transforms: mapTransforms(stackTransforms(stack.shape[2], stack.resolution[2]), (t) => centering ? compose(center, compose(registered[i], t)) : compose(registered[i], t)),
  }));
}

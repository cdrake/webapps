import { Tape } from './autodiff.js';
import { rotation } from './network.js';

// Differentiate the small pose matrices once per slice; PSF samples use packed
// arrays so training memory does not grow with a scalar autodiff graph.
export function poseMatrices(model) {
  return Array.from({ length: model.slices }, (_, slice) => {
    const tape = new Tape();
    const axis = Array.from(model.poses.values.slice(slice * 6, slice * 6 + 3), (v) => tape.constant(v));
    const nodes = rotation(tape, axis).flat();
    const derivatives = new Float64Array(27);
    nodes.forEach((node, i) => {
      tape.nodes.forEach((n) => { n.gradient = 0; });
      tape.backward(node);
      axis.forEach((v, a) => { derivatives[i * 3 + a] = v.gradient; });
    });
    return { matrix: nodes.map((n) => n.value), derivatives };
  });
}

export function prepareBatch(model, batch, matrices = poseMatrices(model)) {
  const count = batch.reduce((n, observation) => n + observation.offsets.length, 0);
  const xyz = new Float32Array(count * 3);
  const local = new Float64Array(count * 3);
  const sliceIndices = new Uint32Array(count);
  const ranges = [];
  let cursor = 0;
  for (const observation of batch) {
    const start = cursor;
    const { slice } = observation;
    const { matrix } = matrices[slice];
    for (const offset of observation.offsets) {
      for (let a = 0; a < 3; a++) local[cursor * 3 + a] = observation.xyz[a] + offset[a] + model.poses.values[slice * 6 + a + 3];
      for (let a = 0; a < 3; a++) {
        xyz[cursor * 3 + a] = matrix.slice(a * 3, a * 3 + 3).reduce((v, r, b) => v + r * local[cursor * 3 + b], 0);
      }
      sliceIndices[cursor++] = slice;
    }
    ranges.push({ start, end: cursor, slice, target: observation.target });
  }
  return { xyz, local, sliceIndices, ranges, matrices };
}

export function batchLoss(model, prepared, outputs, batchCount = prepared.ranges.length) {
  const { density, variance } = outputs;
  const { xyz, ranges } = prepared;
  const densityGradient = new Float32Array(density.length);
  const varianceGradient = new Float32Array(variance.length);
  const xyzGradient = new Float64Array(xyz.length);
  const scaleGradient = new Float64Array(model.slices);
  const max = Math.max(...model.scale.values);
  const weights = Array.from(model.scale.values, (v) => Math.exp(v - max));
  const sum = weights.reduce((a, b) => a + b, 0);
  const scales = weights.map((v) => v * model.slices / sum);
  const terms = { MSE: 0, logVar: 0, imageReg: 0 };
  for (const { start, end, slice, target } of ranges) {
    const n = end - start;
    let mean = 0;
    let uncertainty = 0;
    for (let j = start; j < end; j++) {
      mean += density[j] / n;
      uncertainty += variance[j] / n;
    }
    const c = scales[slice];
    const residual = c * mean - target;
    const sliceVariance = Math.exp(model.variance.values[slice]);
    const v = (c * uncertainty) ** 2 + sliceVariance;
    terms.MSE += residual ** 2 / (2 * v * batchCount);
    terms.logVar += Math.log(v) / (2 * batchCount);
    const dp = residual / (v * batchCount);
    const dv = (0.5 / v - 0.5 * residual ** 2 / v ** 2) / batchCount;
    scaleGradient[slice] += dp * mean;
    model.variance.gradient[slice] += dv * sliceVariance;
    for (let j = start; j < end; j++) {
      densityGradient[j] += dp * c / n;
      varianceGradient[j] += dv * 2 * c * c * uncertainty / n;
      const k = end - 1 - (j - start);
      let distance = 1e-6;
      const spatial2 = model.config.spatialScaling ** 2;
      for (let a = 0; a < 3; a++) distance += spatial2 * (xyz[j * 3 + a] - xyz[k * 3 + a]) ** 2;
      const difference = density[j] - density[k];
      const root = Math.sqrt(1 + difference ** 2 / (distance * model.delta ** 2));
      terms.imageReg += model.delta * (root - 1) / (batchCount * n);
      const weight = model.config.weightImage / (batchCount * n);
      const dd = weight * difference / (model.delta * distance * root);
      densityGradient[j] += dd;
      densityGradient[k] -= dd;
      const dDistance = -weight * difference ** 2 / (2 * model.delta * distance ** 2 * root);
      for (let a = 0; a < 3; a++) {
        const derivative = dDistance * 2 * spatial2 * (xyz[j * 3 + a] - xyz[k * 3 + a]);
        xyzGradient[j * 3 + a] += derivative;
        xyzGradient[k * 3 + a] -= derivative;
      }
    }
  }
  const scaleMean = scaleGradient.reduce((v, g, s) => v + g * scales[s] / model.slices, 0);
  scales.forEach((c, s) => { model.scale.gradient[s] += c * (scaleGradient[s] - scaleMean); });
  return { terms, densityGradient, varianceGradient, xyzGradient };
}

export function accumulatePoseGradient(model, prepared, fieldGradient, lossGradient) {
  const { local, sliceIndices, matrices } = prepared;
  for (let i = 0; i < sliceIndices.length; i++) {
    const slice = sliceIndices[i];
    const { matrix, derivatives } = matrices[slice];
    for (let a = 0; a < 3; a++) {
      const gradient = fieldGradient[i * 3 + a] + lossGradient[i * 3 + a];
      for (let b = 0; b < 3; b++) {
        model.poses.gradient[slice * 6 + b + 3] += gradient * matrix[a * 3 + b];
        for (let axis = 0; axis < 3; axis++) model.poses.gradient[slice * 6 + axis] += gradient * derivatives[(a * 3 + b) * 3 + axis] * local[i * 3 + b];
      }
    }
  }
}

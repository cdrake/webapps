import { Tape, adamW } from './autodiff.js';
import { gaussian, transformationLoss } from './index.js';
import { prepareBatch, batchLoss, accumulatePoseGradient, poseMatrices } from './batch-objective.js';

export async function gpuTrainingStep(model, field, batch, step, { learningRate = model.config.learningRate, observationsPerChunk = 4, deformation, signal, onProgress = () => {} } = {}) {
  const hostParameters = [model.scale, model.variance, model.poses];
  hostParameters.forEach((p) => p.zeroGrad());
  const matrices = poseMatrices(model);
  const terms = { MSE: 0, logVar: 0, imageReg: 0, transReg: 0, ...(deformation ? { deformReg: 0 } : {}) };
  let lastReport = performance.now();
  onProgress({ completed: 0, total: batch.length });
  for (let start = 0; start < batch.length; start += observationsPerChunk) {
    signal?.throwIfAborted();
    const prepared = prepareBatch(model, batch.slice(start, start + observationsPerChunk), matrices);
    const queries = deformation ? { ...prepared, xyz: (await deformation.forward(prepared, { signal })).xyz } : prepared;
    const outputs = await field.forward(queries, { signal });
    const loss = batchLoss(model, queries, outputs, batch.length);
    const backward = await field.backward({ ...queries, densityGradient: loss.densityGradient, varianceGradient: loss.varianceGradient }, { accumulate: start > 0, readGradients: false, signal });
    if (deformation) {
      const xyzGradient = Float32Array.from(backward.xyzGradient, (value, i) => value + loss.xyzGradient[i]);
      const regularizationWeights = new Float32Array(prepared.sliceIndices.length);
      for (const range of prepared.ranges) {
        const count = Math.min(4, range.end - range.start);
        regularizationWeights.fill(model.config.weightDeform / (batch.length * count), range.start, range.start + count);
      }
      const warpedBackward = await deformation.backward({ ...prepared, xyzGradient, regularizationWeights }, { accumulate: start > 0, readGradients: false, signal });
      for (const range of prepared.ranges) {
        const count = Math.min(4, range.end - range.start);
        for (let i = range.start; i < range.start + count; i++) terms.deformReg += warpedBackward.regularization[i] / (batch.length * count);
      }
      accumulatePoseGradient(model, prepared, warpedBackward.xyzGradient, new Float64Array(prepared.xyz.length));
    } else {
      accumulatePoseGradient(model, prepared, backward.xyzGradient, loss.xyzGradient);
    }
    for (const name of ['MSE', 'logVar', 'imageReg']) terms[name] += loss.terms[name];
    const completed = Math.min(start + observationsPerChunk, batch.length);
    if (completed === batch.length || performance.now() - lastReport >= 1000) {
      onProgress({ completed, total: batch.length });
      lastReport = performance.now();
    }
  }
  const tape = new Tape();
  const poses = Array.from({ length: model.slices }, (_, s) => Array.from({ length: 6 }, (_, a) => model.poses.at(tape, s * 6 + a)));
  const regularizer = transformationLoss(model, tape, poses);
  terms.transReg = regularizer.value;
  tape.backward(tape.scale(regularizer, model.config.weightTransformation));
  signal?.throwIfAborted();
  await field.step(step, learningRate);
  if (deformation) await deformation.step(step, learningRate);
  adamW(hostParameters, step, { learningRate });
  return terms;
}

export async function fitGPU(model, field, observations, { iterations = model.config.iterations, batchSize = model.config.batchSize, samples = model.config.samples, random = Math.random, deformation, signal, onProgress = () => {} } = {}) {
  if (!observations.length) throw new Error('No masked observations');
  const indices = Uint32Array.from(observations, (_, i) => i);
  let cursor = indices.length;
  for (let step = 1; step <= iterations; step++) {
    signal?.throwIfAborted();
    if (cursor + batchSize > indices.length) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      cursor = 0;
    }
    const batch = Array.from(indices.slice(cursor, cursor + batchSize), (index) => {
      const observation = observations[index];
      return { ...observation, offsets: Array.from({ length: samples }, () => observation.sigma.map((sigma) => gaussian(random) * sigma)) };
    });
    cursor += batchSize;
    const decays = [0.5, 0.75, 0.9].filter((fraction) => step > Math.floor(fraction * iterations)).length;
    const losses = await gpuTrainingStep(model, field, batch, step, { learningRate: model.config.learningRate * 0.33 ** decays, deformation, signal, onProgress: (progress) => onProgress({ stage: 'training-batch', iteration: step, iterations, ...progress }) });
    onProgress({ step, iterations, losses });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return model;
}

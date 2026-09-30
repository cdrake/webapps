import test from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceNeSVoR, Tape } from '../src/training/index.js';
import { prepareBatch, batchLoss, accumulatePoseGradient } from '../src/training/batch-objective.js';
import { gpuTrainingStep } from '../src/training/gpu-fit.js';

test('packed PSF loss and pose derivatives match scalar reverse mode', async () => {
  let seed = 57;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 2 ** 32;
  const model = new ReferenceNeSVoR({ boundingBox: [[-1,-1,-1],[1,1,1]], poses: [.1,-.05,.2,.01,-.1,.03, -.2,.1,.03,-.1,.02,.1], mean: 1, log2Size: 3, coarsest: 60, finest: 30, width: 4, latent: 2, sliceFeatures: 2, weightTransformation: 0 }, random);
  model.scale.values.set([.2,-.1]);
  const batch = [0,1,0].map((slice, i) => ({ slice, xyz: [.12+i*.1,-.2,.05], target: .7+i*.2, offsets: [[.01,.02,.03],[-.03,.01,-.04],[.02,-.03,.01]] }));
  const reference = model.objective(batch);
  reference.tape.backward(reference.total);
  const expected = model.parameters.map((p) => Array.from(p.gradient));
  model.parameters.forEach((p) => p.zeroGrad());
  const prepared = prepareBatch(model, batch);
  const tapes = [];
  const density = [], variance = [];
  for (let i = 0; i < prepared.sliceIndices.length; i++) {
    const tape = new Tape();
    const xyz = Array.from(prepared.xyz.slice(i*3,i*3+3), (x) => tape.constant(x));
    const result = model.evaluate(tape, xyz, prepared.sliceIndices[i]);
    tapes.push({ tape, xyz, result });
    density.push(result.density.value);
    variance.push(result.variance.value);
  }
  const loss = batchLoss(model, prepared, { density, variance });
  const coordinateGradient = [];
  tapes.forEach(({tape,xyz,result}, i) => {
    tape.backward(tape.add(tape.scale(result.density, loss.densityGradient[i]), tape.scale(result.variance, loss.varianceGradient[i])));
    coordinateGradient.push(...xyz.map((x) => x.gradient));
  });
  accumulatePoseGradient(model, prepared, coordinateGradient, loss.xyzGradient);
  for (const key of ['MSE','logVar','imageReg']) assert.ok(Math.abs(loss.terms[key] - reference.terms[key].value) < 1e-7, key);
  model.parameters.forEach((p, group) => p.gradient.forEach((value, index) => assert.ok(Math.abs(value - expected[group][index]) < 2e-6, `parameter ${group}:${index}: ${value} != ${expected[group][index]}`)));
});

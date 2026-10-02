import test from 'node:test';
import assert from 'node:assert/strict';
import { Tape, Parameter, adamW, HashGrid, ReferenceNeSVoR, transform } from '../src/training/index.js';

function seeded() {
  let state = 42;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 0.5) / 4294967296; };
}
function close(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

test('hash interpolation gradients include colliding corners and coordinates', () => {
  const grid = new HashGrid({ levels: 2, features: 2, log2Size: 1, baseResolution: 3 }, seeded());
  const xyz = [0.21, 0.37, 0.43];
  const evaluate = (point) => {
    const tape = new Tape();
    const nodes = point.map((x) => tape.constant(x));
    const value = tape.sum(grid.forward(tape, nodes));
    tape.backward(value);
    return { value: value.value, gradient: nodes.map((x) => x.gradient) };
  };
  const result = evaluate(xyz);
  for (let axis = 0; axis < 3; axis++) {
    const a = [...xyz], b = [...xyz];
    a[axis] += 1e-5;
    b[axis] -= 1e-5;
    close(result.gradient[axis], (evaluate(a).value - evaluate(b).value) / 2e-5, 1e-8);
  }
  grid.table.zeroGrad();
  evaluate(xyz);
  const gradients = Array.from(grid.table.gradient);
  for (let i = 0; i < gradients.length; i++) {
    const original = grid.table.values[i];
    grid.table.values[i] = original + 1e-5;
    const a = evaluate(xyz).value;
    grid.table.values[i] = original - 1e-5;
    const b = evaluate(xyz).value;
    grid.table.values[i] = original;
    close(gradients[i], (a - b) / 2e-5, 1e-6);
  }
});

test('rigid transform is translation first and differentiable at zero rotation', () => {
  const tape = new Tape();
  const pose = [0, 0, 0, 1, 2, 3].map((x) => tape.constant(x));
  const point = [2, 1, 4].map((x) => tape.constant(x));
  const result = transform(tape, pose, point);
  assert.deepEqual(result.map((x) => x.value), [3, 3, 7]);
  tape.backward(result[0]);
  assert.deepEqual(pose.map((x) => x.gradient), [0, 7, -3, 1, 0, 0]);
});

test('AdamW includes inherited 0.01 decay in all parameter groups', () => {
  const p = new Parameter([2, -3]);
  p.gradient.set([0.4, -0.2]);
  adamW([p], 1, { learningRate: 0.005 });
  close(p.values[0], 2 * (1 - 0.005 * 0.01) - 0.005);
  close(p.values[1], -3 * (1 - 0.005 * 0.01) + 0.005);
  close(p.first[0], 0.04);
  close(p.second[0], 0.0016);
});

function smallModel() {
  return new ReferenceNeSVoR({ boundingBox: [[-1, -1, -1], [1, 1, 1]], poses: [0.03, -0.04, 0.02, 0.01, 0.02, -0.03], mean: 1, log2Size: 3, width: 3, latent: 2, sliceFeatures: 2, coarsest: 32, finest: 16 }, seeded());
}
const batch = [{ slice: 0, xyz: [0.1, 0.2, 0.3], target: 1.2, offsets: [[-0.03, 0.01, -0.02], [0.02, -0.01, 0.03]] }];

test('complete objective derivatives agree with finite differences', () => {
  const model = smallModel();
  const result = model.objective(batch);
  result.tape.backward(result.total);
  assert.deepEqual(Object.keys(result.terms), ['MSE', 'logVar', 'imageReg', 'transReg']);
  for (const parameter of [model.density.layers[1].bias, model.uncertainty.layers[1].bias, model.embedding, model.variance, model.poses]) {
    const analytic = Array.from(parameter.gradient);
    for (let i = 0; i < parameter.values.length; i++) {
      const original = parameter.values[i];
      parameter.values[i] = original + 1e-3;
      const aValue = parameter.values[i];
      const a = model.objective(batch).total.value;
      parameter.values[i] = original - 1e-3;
      const bValue = parameter.values[i];
      const b = model.objective(batch).total.value;
      parameter.values[i] = original;
      close(analytic[i], (a - b) / (aValue - bValue), 2e-4);
    }
  }
});

test('reference learns a tiny observation with all default objective branches', () => {
  const model = smallModel();
  const before = model.objective(batch).total.value;
  for (let step = 1; step <= 20; step++) model.step(batch, step);
  const after = model.objective(batch).total.value;
  assert.ok(after < before, `${after} >= ${before}`);
  assert.ok(Number.isFinite(model.sample([0.1, 0.2, 0.3])));
});

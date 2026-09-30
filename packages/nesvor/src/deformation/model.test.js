import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeformationModel, evaluateDeformation } from './model.js';

function model() {
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
  const result = createDeformationModel({ boundingBox: [[-1, -2, -3], [1, 2, 3]], slices: 2, features: 2, embeddingFeatures: 3, log2Size: 2, coarsest: 64, finest: 32, width: 5 }, random);
  for (const p of result.parameters) for (let i = 0; i < p.values.length; i++) p.values[i] = (random() - 0.5) * 0.7;
  return result;
}

test('deformation regularizer detaches input coordinates and slice embedding', () => {
  const m = model();
  const result = evaluateDeformation(m, [0.17, -0.61, 0.32], 1, { backward: true, regularizationWeight: 1 });
  assert.ok(result.regularization > 0);
  assert.deepEqual(result.xyzGradient, [0, 0, 0]);
  assert.ok(m.embedding.gradient.every(x => x === 0));
  assert.ok(m.table.gradient.some(x => Math.abs(x) > 1e-5));
});

test('smoothstep jets and exact parameter derivatives agree with numerical checks', () => {
  const m = model();
  const point = [0.17, -0.61, 0.32];
  const cotangent = [0.1, -0.2, 0.3];
  const weight = 0.7;
  const result = evaluateDeformation(m, point, 1, { backward: true, xyzGradient: cotangent, regularizationWeight: weight });
  const objective = () => {
    const value = evaluateDeformation(m, point, 1);
    return value.xyz.reduce((sum, x, a) => sum + x * cotangent[a], weight * value.regularization);
  };
  for (const parameter of m.parameters.slice(0, -1)) {
    for (let i = 0; i < parameter.values.length; i += Math.max(1, Math.floor(parameter.values.length / 7))) {
      const original = parameter.values[i];
      parameter.values[i] = original + 1e-4;
      const plus = objective();
      const actualPlus = parameter.values[i];
      parameter.values[i] = original - 1e-4;
      const minus = objective();
      const actualMinus = parameter.values[i];
      parameter.values[i] = original;
      const derivative = (plus - minus) / (actualPlus - actualMinus);
      assert.ok(Math.abs(derivative - parameter.gradient[i]) < 1e-5, `parameter derivative ${derivative} != ${parameter.gradient[i]}`);
    }
  }
  for (let a = 0; a < 3; a++) {
    const plus = [...point];
    const minus = [...point];
    plus[a] += 1e-5;
    minus[a] -= 1e-5;
    const yp = evaluateDeformation(m, plus, 1).xyz;
    const ym = evaluateDeformation(m, minus, 1).xyz;
    for (let o = 0; o < 3; o++) assert.ok(Math.abs((yp[o] - ym[o]) / 2e-5 - result.jacobian[o][a]) < 1e-7);
  }
});

test('zero deformation network preserves world coordinates with zero Jacobian penalty', () => {
  const m = model();
  m.layers.forEach(l => { l.weight.values.fill(0); l.bias.values.fill(0); });
  const point = [0.17, -0.61, 0.32];
  const result = evaluateDeformation(m, point, 1);
  assert.deepEqual(result.xyz, point);
  assert.equal(result.regularization, 0);
  assert.deepEqual(result.jacobian, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

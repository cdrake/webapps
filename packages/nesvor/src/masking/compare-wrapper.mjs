import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { prepareStack, segmentStacks } from './index.js';

const cases = JSON.parse(await readFile(process.argv[2], 'utf8'));
let maximum = 0;
for (const fixture of cases) {
  const stack = { ...fixture, data: Float32Array.from(fixture.data), mask: new Uint8Array(fixture.data.length).fill(1) };
  const prepared = prepareStack(stack);
  prepared.data.forEach((value, i) => {
    const error = Math.abs(value - fixture.normalized[i]);
    maximum = Math.max(maximum, error);
    assert.ok(error < 1e-5, `Normalization differs at ${i}: ${error}`);
  });
  const infer = async (input) => {
    const logits = new Float32Array(input.length * 2);
    input.forEach((value, i) => {
      logits[i] = value * -.3;
      logits[input.length + i] = value + .2;
    });
    return logits;
  };
  const [result] = await segmentStacks([stack], { infer, augmentation: fixture.augmentation });
  assert.deepEqual([...result.mask], fixture.mask);
}
console.log(JSON.stringify({ passed: true, cases: cases.length, maxNormalizationError: maximum, maskAgreement: 1 }, null, 2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ReferenceNeSVoR, adamW } from '../src/training/index.js';
const fixture = JSON.parse(await readFile(new URL('./upstream-training.json', import.meta.url)));

test('field, full objective, pose gradients and AdamW match pinned upstream PyTorch', () => {
  assert.equal(fixture.sourceCommit, '730ddaa3711a2304386de34193ea4b957892fe7b');
  const model = new ReferenceNeSVoR(fixture.config, () => .4);
  model.parameters.forEach((p,i) => p.values.set(fixture.parameters[i]));
  const {tape,total,terms} = model.objective(fixture.batch);
  tape.backward(total);
  for (const [name,term] of Object.entries(terms)) assert.ok(Math.abs(term.value-fixture.losses[name]) < 2e-6, `${name}: ${term.value} != ${fixture.losses[name]}`);
  const compare = (actual,expected,tolerance,label) => {
    assert.equal(actual.length,expected.length);
    actual.forEach((value,i) => assert.ok(Math.abs(value-expected[i]) < tolerance, `${label} ${i}: ${value} != ${expected[i]}`));
  };
  model.parameters.forEach((p,i) => compare(p.gradient,fixture.gradients[i],2e-5,`gradient group ${i}`));
  adamW(model.parameters,1);
  model.parameters.forEach((p,i) => compare(p.values,fixture.updated[i],2e-5,`Adam group ${i}`));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readContract, parseContract, validateRequest, generateJob, contractJsonSchema } from '../src/contracts.js';

const synthseg = await readContract(new URL('../../../apps/synthseg/automation.json', import.meta.url));
const extraction = await readContract(new URL('../../../apps/brain-extraction/automation.json', import.meta.url));

async function input(t) {
  const directory = await mkdtemp(join(tmpdir(), 'automation-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'head.nii');
  await writeFile(path, 'fixture');
  return { inputs: { image: [path] } };
}

test('contracts generate complete jobs with an explicit terminal state and report download', async t => {
  const value = await input(t);
  for (const contract of [synthseg, extraction]) {
    const request = await validateRequest(contract, value);
    const job = generateJob(contract, request);
    assert.equal(job.steps[0].action, 'upload');
    assert.equal(job.steps[1].value, 'ready');
    assert.ok(job.steps.some(step => step.condition === 'state' && step.value === 'succeeded'));
    assert.equal(job.steps.at(-1).artifact, 'report');
    assert.equal(job.expectedDownloads, Object.keys(contract.artifacts).length + 1);
    assert.equal(job.failSelector, null);
    assert.equal(contract.lifecycle.snapshotSelector, '#neurodesk-run');
    assert.equal(contract.lifecycle.stateAttribute, 'data-neurodesk-state');
  }
  assert.deepEqual(contractJsonSchema().oneOf.map(schema => schema.properties.schemaVersion.const), [1, 2]);
});

test('input validation rejects missing files, relative paths, unknown inputs and invalid parameters', async t => {
  const value = await input(t);
  await assert.rejects(validateRequest(synthseg, { inputs: { image: ['relative.nii'] } }), /absolute/);
  await assert.rejects(validateRequest(synthseg, { inputs: { image: ['/missing/head.nii'] } }), /ENOENT/);
  await assert.rejects(validateRequest(synthseg, { ...value, parameters: { mode: 'guess' } }));
  await assert.rejects(validateRequest(synthseg, { ...value, inputs: { ...value.inputs, mask: value.inputs.image } }));
  await assert.rejects(validateRequest(extraction, { ...value, parameters: { threshold: 1.5 } }));
  await assert.rejects(validateRequest(extraction, { ...value, parameters: { backend: 'metal' } }));
  await assert.rejects(validateRequest(extraction, { ...value, timeoutMs: 0 }));
});

test('omitted CT retains app detection and an explicit value applies after input readiness', async t => {
  const value = await input(t);
  const omitted = await validateRequest(synthseg, value);
  assert.equal(Object.hasOwn(omitted.parameters, 'ct'), false);
  const explicit = await validateRequest(synthseg, { ...value, parameters: { ct: false } });
  const steps = generateJob(synthseg, explicit).steps;
  assert.ok(steps.findIndex(step => step.selector === '#ct') > steps.findIndex(step => step.value === 'ready'));
  assert.equal(steps.find(step => step.selector === '#ct').value, false);
});

test('contract parser rejects incompatible control types and invalid defaults', () => {
  const contract = structuredClone(extraction);
  contract.parameters.method.action = 'check';
  assert.throws(() => parseContract(contract), /boolean/);
  contract.parameters.method.action = 'select';
  contract.parameters.threshold.default = 4;
  assert.throws(() => parseContract(contract));
});

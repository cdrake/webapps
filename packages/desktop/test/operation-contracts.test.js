import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseContract, requestSchema, validateRequest, operationFor } from '../src/contracts.js';

const registration = {
  schemaVersion: 2, app: 'registration', title: 'Registration', description: 'Register images',
  defaultOperation: 'register',
  operations: {
    register: {
      title: 'Register', description: 'Register moving to fixed', mode: 'batch',
      inputs: Object.fromEntries(['fixed', 'moving'].map(role => [role, {
        source: 'files', type: 'neuro:volume', formats: ['nifti', 'dicom'], description: role,
      }])),
      parameters: {
        iterations: { type: 'array', items: { type: 'integer', description: 'Iterations', minimum: 0 }, default: [20, 10], description: 'Iterations per resolution' },
        method: { type: 'string', enum: ['affine', 'deformable'], default: 'affine', description: 'Method' },
      },
      artifacts: {
        registered: { type: 'neuro:volume', mediaType: 'application/x-nifti', minimum: 1, maximum: 1 },
        transforms: { type: ['neuro:volume', 'neuro:transform'], mediaType: 'application/octet-stream', minimum: 0, maximum: 3 },
      },
      engines: ['browser'],
    },
    inspect: {
      title: 'Inspect', description: 'Inspect a store', mode: 'viewer',
      inputs: { store: { source: 'directory', type: 'neuro:omezarr', description: 'Local store' } },
      parameters: {}, artifacts: {}, engines: ['browser'],
    },
  },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'operation-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixed = join(directory, 'fixed.nii');
  const moving = join(directory, 'moving.nii.gz');
  await Promise.all([writeFile(fixed, 'fixed fixture'), writeFile(moving, 'moving fixture')]);
  return { directory, inputs: { fixed: [fixed], moving: [moving] } };
}

test('operation requests derive typed defaults and reject wrong operations and unknown fields', async t => {
  const contract = parseContract(registration);
  const { inputs } = await fixture(t);
  const request = await validateRequest(contract, { inputs });
  assert.equal(request.operation, 'register');
  assert.equal(request.retainViewer, false);
  assert.deepEqual(request.parameters, { iterations: [20, 10], method: 'affine' });
  assert.equal(operationFor(contract, request.operation).artifacts.transforms.maximum, 3);
  await assert.rejects(validateRequest(contract, { inputs, operation: 'guessed' }), /Unknown operation/);
  await assert.rejects(validateRequest(contract, { inputs, parameters: { iterations: [1.5] } }));
  await assert.rejects(validateRequest(contract, { inputs, parameters: { iterations: [-1] } }));
  await assert.rejects(validateRequest(contract, { inputs, parameters: { invented: true } }));
  await assert.rejects(validateRequest(contract, { inputs, selections: { fixed: 'not-a-hash' } }));
});

test('DICOM directories expand deterministically and duplicate files are rejected', async t => {
  const contract = parseContract(registration);
  const { directory, inputs } = await fixture(t);
  const series = join(directory, 'dicom');
  await mkdir(join(series, 'nested'), { recursive: true });
  await writeFile(join(series, 'slice2'), 'DICOM');
  await writeFile(join(series, 'nested/slice1'), 'DICOM');
  const request = await validateRequest(contract, { inputs: { ...inputs, moving: [series] } });
  assert.deepEqual(request.inputs.moving, [join(series, 'nested/slice1'), join(series, 'slice2')]);
  await assert.rejects(validateRequest(contract, { inputs: { ...inputs, fixed: [...inputs.fixed, ...inputs.fixed] } }), /duplicate/);
});

test('viewer operations validate directory sources and retain sessions by default', async t => {
  const contract = parseContract(registration);
  const { directory, inputs } = await fixture(t);
  const request = await validateRequest(contract, { operation: 'inspect', inputs: { store: { directory } } });
  assert.equal(request.retainViewer, true);
  await assert.rejects(validateRequest(contract, { operation: 'inspect', inputs: { store: { directory: inputs.fixed[0] } } }), /not a directory/);
  assert.throws(() => requestSchema(contract, 'inspect').parse({ inputs: { store: { url: 'https://example.org' } } }));
});

test('contracts reject undeclared defaults, invalid cardinality and array shapes', () => {
  assert.throws(() => parseContract({ ...registration, defaultOperation: 'missing' }), /Default operation/);
  const invalid = structuredClone(registration);
  invalid.operations.register.artifacts.registered.minimum = 3;
  assert.throws(() => parseContract(invalid), /cardinality/);
  invalid.operations.register.artifacts.registered.minimum = 1;
  delete invalid.operations.register.parameters.iterations.items;
  assert.throws(() => parseContract(invalid), /require items/);
});

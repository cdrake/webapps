import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import * as z from 'zod/v4';

const selector = z.string().trim().min(1);
const name = z.string().regex(/^[a-z][a-z0-9-]*$/);
const lifecycle = {
  selector: '#statusText',
  snapshotSelector: '#neurodesk-run',
  stateAttribute: 'data-neurodesk-state',
  runIdAttribute: 'data-neurodesk-run-id',
  ready: 'ready',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};
const parameter = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  selector,
  action: z.enum(['select', 'fill', 'check']),
  enum: z.array(z.string()).min(1).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  multipleOf: z.number().positive().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const contractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  app: name,
  appVersion: z.string().regex(/^\d+\.\d+\.\d{8}$/).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  inputs: z.record(name, z.strictObject({
    type: z.literal('neuro:volume'),
    formats: z.array(z.literal('nifti')).min(1),
    space: z.string().min(1),
    description: z.string().min(1),
    selector,
  })).refine(value => Object.keys(value).length > 0, 'Declare at least one input'),
  parameters: z.record(name, parameter),
  artifacts: z.record(name, z.strictObject({
    type: z.enum(['neuro:volume', 'neuro:mask', 'neuro:label-map']),
    mediaType: z.string().min(1),
    space: z.string().min(1),
    labelSystem: z.string().optional(),
    selector,
  })).refine(value => Object.keys(value).length > 0, 'Declare at least one artifact'),
  controls: z.strictObject({ run: selector, cancel: selector, report: selector }),
  lifecycle: z.strictObject(Object.fromEntries(Object.entries(lifecycle).map(([key, value]) => [key, z.literal(value)]))).default(lifecycle),
  engines: z.array(z.enum(['browser', 'native'])).min(1),
});

export const contractJsonSchema = () => z.toJSONSchema(contractSchema);

export function parseContract(value) {
  const contract = contractSchema.parse(value);
  for (const [key, field] of Object.entries(contract.parameters)) {
    if ((field.action === 'check') !== (field.type === 'boolean')) throw new Error(`${key}: check requires a boolean parameter`);
    if (field.action === 'select' && (field.type !== 'string' || !field.enum)) throw new Error(`${key}: select requires a string enum`);
    if (field.enum && field.type !== 'string') throw new Error(`${key}: enum requires a string parameter`);
    if ((field.minimum !== undefined || field.maximum !== undefined || field.multipleOf !== undefined) && field.type !== 'number') throw new Error(`${key}: bounds require a number`);
    if (field.minimum > field.maximum) throw new Error(`${key}: minimum exceeds maximum`);
    if (field.default !== undefined) parameterSchema(field).parse(field.default);
  }
  return contract;
}

export function parameterSchema(field) {
  let schema;
  if (field.type === 'boolean') schema = z.boolean();
  else if (field.type === 'number') {
    schema = z.number().finite();
    if (field.minimum !== undefined) schema = schema.min(field.minimum);
    if (field.maximum !== undefined) schema = schema.max(field.maximum);
    if (field.multipleOf !== undefined) schema = schema.multipleOf(field.multipleOf);
  } else schema = field.enum ? z.enum(field.enum) : z.string();
  return schema.describe(field.description);
}

export function requestSchema(contract) {
  return z.strictObject({
    inputs: z.strictObject(Object.fromEntries(Object.entries(contract.inputs).map(([role, field]) => [
      role, z.array(z.string().min(1)).length(1).describe(`${field.description} Absolute path to one NIfTI file.`),
    ]))),
    parameters: z.strictObject(Object.fromEntries(Object.entries(contract.parameters).map(([key, field]) => [
      key, field.default === undefined ? parameterSchema(field).optional() : parameterSchema(field).default(field.default),
    ]))).prefault({}),
    engine: z.enum(contract.engines).default('browser'),
    timeoutMs: z.number().int().min(1).max(86400000).default(1800000),
  });
}

export async function validateRequest(contract, value) {
  const request = requestSchema(contract).parse(value);
  for (const paths of Object.values(request.inputs)) {
    for (const path of paths) {
      if (!isAbsolute(path)) throw new Error(`Input path must be absolute: ${path}`);
      if (!/\.nii(?:\.gz)?$/i.test(path)) throw new Error(`Input must be NIfTI: ${path}`);
      if (!(await stat(path)).isFile()) throw new Error(`Input is not a file: ${path}`);
    }
  }
  return request;
}

export function generateJob(contract, request) {
  if (request.engine !== 'browser') throw new Error('Selector jobs require the browser engine');
  return {
    schemaVersion: 1,
    app: contract.app,
    timeoutMs: request.timeoutMs,
    failSelector: null,
    expectedDownloads: Object.keys(contract.artifacts).length + 1,
    automation: { contract },
    steps: [
      ...Object.entries(contract.inputs).flatMap(([role, field]) => [
        { action: 'upload', selector: field.selector, paths: request.inputs[role], input: role },
        { action: 'wait', selector: contract.lifecycle.selector, condition: 'state', value: contract.lifecycle.ready },
      ]),
      ...Object.entries(request.parameters).map(([key, value]) => ({
        action: contract.parameters[key].action,
        selector: contract.parameters[key].selector,
        value,
      })),
      { action: 'click', selector: contract.controls.run },
      { action: 'wait', selector: contract.lifecycle.selector, condition: 'state', value: contract.lifecycle.succeeded },
      ...Object.entries(contract.artifacts).map(([role, field]) => ({ action: 'click', selector: field.selector, artifact: role })),
      { action: 'click', selector: contract.controls.report, artifact: 'report' },
    ],
  };
}

export async function readContract(path) {
  return parseContract(JSON.parse(await readFile(path, 'utf8')));
}

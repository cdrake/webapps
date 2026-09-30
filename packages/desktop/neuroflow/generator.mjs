import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseContract } from '../src/contracts.js';
import { canonical, contractHash } from './runtime/contract.mjs';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const name of ['common', 'events', 'tool', 'neuroflow-mcp']) {
  ajv.addSchema(JSON.parse(await readFile(new URL(`./vendor/${name}.schema.json`, import.meta.url))));
}
const schemaId = 'https://niivue.github.io/neuroflow-spec/schemas/0.1/tool.schema.json';
const validate = ajv.getSchema(schemaId);
const validateMcp = ajv.getSchema('https://niivue.github.io/neuroflow-spec/schemas/0.1/extensions/neuroflow-mcp.schema.json');
const artifactTypes = new Set([
  'neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:transform',
  'neuro:surface', 'neuro:report',
]);
const aliases = { 'neuro:table': 'core:tabular', 'neuro:tractogram': 'neuro:tract', 'neuro:gradients': 'neuro:gradient-table' };

function artifactType(type) {
  if (Array.isArray(type)) return 'core:file';
  if (artifactTypes.has(type) || type.startsWith('file:')) return type;
  return aliases[type] ?? `neurodesk:${type.slice(type.indexOf(':') + 1)}`;
}

function parameterType(field) {
  if (field.type !== 'array') return `core:${field.type}`;
  const item = field.items.type === 'array' ? 'core:json' : parameterType(field.items);
  return `core:array<${item}>`;
}

function dataDeclaration(field, description, type) {
  return {
    type,
    description,
    optional: field.minimum === 0,
    extensions: { 'neurodesk/data': structuredClone(field) },
  };
}

export function validateTool(tool) {
  if (!validate(tool)) throw new Error(`Invalid NeuroFlow tool: ${ajv.errorsText(validate.errors)}`);
  if (!validateMcp(tool.extensions?.['neuroflow/mcp'])) throw new Error(`Invalid NeuroFlow MCP binding: ${ajv.errorsText(validateMcp.errors)}`);
  return tool;
}

export function generateTools(value) {
  const contract = parseContract(value);
  if (contract.schemaVersion !== 2) throw new Error('NeuroFlow generation requires a schema-2 automation contract');
  if (!contract.appVersion) throw new Error('NeuroFlow generation requires appVersion');
  return Object.entries(contract.operations).sort(([a], [b]) => a.localeCompare(b)).map(([id, operation]) => {
    const fullName = `neurodesk_${contract.app}__${id}`;
    const mcpName = fullName.length <= 64 ? fullName : `${fullName.slice(0, 47)}_${contractHash(fullName).slice(0, 16)}`;
    const inputs = {};
    const outputs = {};
    const bindings = { inputs: {}, parameters: {}, artifacts: {} };
    for (const [role, field] of Object.entries(operation.inputs)) {
      const name = `input_${role}`;
      bindings.inputs[role] = name;
      const type = field.source === 'url' ? 'core:string' : field.source === 'directory'
        ? 'core:directory' : `core:array<${artifactType(field.type)}>`;
      inputs[name] = dataDeclaration(field, field.description, type);
    }
    for (const [key, field] of Object.entries(operation.parameters)) {
      const name = `param_${key}`;
      bindings.parameters[key] = name;
      inputs[name] = {
        type: parameterType(field), description: field.description, optional: true,
        ...(field.default !== undefined && { default: structuredClone(field.default) }),
        ...(field.enum && { enum: [...field.enum] }),
        ...(['number', 'integer'].includes(field.type) && {
          ...(field.minimum !== undefined && { min: field.minimum }),
          ...(field.maximum !== undefined && { max: field.maximum }),
        }),
        extensions: { 'neurodesk/parameter': structuredClone(field) },
      };
    }
    inputs.engine = {
      type: 'core:string', description: 'Desktop execution engine. Availability is checked before execution.',
      enum: [...operation.engines], default: operation.engines[0], optional: true,
    };
    for (const [role, field] of Object.entries(operation.artifacts)) {
      const name = `output_${role}`;
      bindings.artifacts[role] = name;
      outputs[name] = dataDeclaration(field, `${operation.title}: ${role}`, `core:array<${artifactType(field.type)}>`);
    }
    outputs.report = { type: 'core:file', description: 'Verified Neurodesk run report, including provenance, measurements and artifact hashes.' };
    const tool = {
      $schema: schemaId, neuroflow: '0.1.0', kind: 'tool',
      id: `neurodesk.webapps/${contract.app}/${id}`, version: contract.appVersion,
      description: operation.description,
      inputs, outputs, outputDelivery: { default: 'core:result-file' },
      extensions: {
        'neuroflow/mcp': { name: mcpName, title: `${contract.title}: ${operation.title}` },
        'neuroflow/launch': {
          kind: 'script', interpreter: 'node', script: '../../scripts/neurodesk.mjs',
          completion: 'exit', interactive: false,
          requirements: ['Node.js >= 22', 'Neurodesk Webapps desktop suite with schema-2 MCP automation'],
        },
        'neurodesk/automation': {
          schemaVersion: 1, operation: id, contract, contractSha256: contractHash(contract), ...bindings,
        },
      },
    };
    return canonical(validateTool(tool));
  });
}

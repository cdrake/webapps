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
  'neuro:surface', 'neuro:report', 'neuro:ome-zarr',
]);
// Contract types whose representation matches a NeuroFlow 0.1 type. A mapped
// entry may add the format token (RFC 0010) that names the representation.
const aliases = {
  'neuro:table': { type: 'core:tabular' },
  'neuro:tractogram': { type: 'neuro:tract' },
  'neuro:gradients': { type: 'neuro:gradient-table' },
  'neuro:multiscale-volume': { type: 'neuro:ome-zarr' },
  'neuro:displacement-field': { type: 'neuro:transform', formats: ['displacement-field'] },
};

// RFC 0010 registered format tokens, and the contract spellings that map onto
// one. A spelling that names a category rather than an encoding (surface) is
// dropped; every other unregistered spelling keeps a neurodesk: prefix.
const formatTokens = new Set([
  'nifti', 'nii', 'nii-gz', 'nii-pair', 'analyze', 'mgh', 'mgz', 'nrrd', 'seg-nrrd', 'minc', 'mha', 'mif',
  'brik-head', 'ecat', 'npy', 'dicom', 'dicom-seg', 'ome-zarr', 'gifti', 'freesurfer-surface',
  'freesurfer-annot', 'freesurfer-label', 'mz3', 'obj', 'ply', 'stl', 'vtk', 'cifti', 'cifti-dtseries',
  'cifti-dscalar', 'cifti-dlabel', 'cifti-dconn', 'cifti-pconn', 'cifti-ptseries', 'cifti-pscalar', 'trk',
  'tck', 'trx', 'bval-bvec', 'bval', 'bvec', 'fsl-mat', 'fnirt-coef', 'fnirt-field', 'x5', 'itk-transform',
  'displacement-field', 'spm-deformation', 'mrtrix-warp', 'afni-1d', 'lta', 'xfm', 'matlab-mat',
  'freesurfer-lut', 'onnx', 'dseg-tsv', 'json', 'tsv', 'csv',
]);
const formatSpellings = { gii: 'gifti', bvals: 'bval', bvecs: 'bvec', surface: null };
// Spaces the RFC 0010 migration table leaves to the app owner. Until an owner
// names the template (a BIDS label) or the input each one means, they are
// vendor-prefixed: compared literally, never mistaken for a registered label.
const vendorSpaces = new Set(['MNI152-1mm', 'atlas', 'analysis', 'lesion-reference', 'RAS-mm', 'scanner-RAS-mm', 'registration-sphere']);
const labelSystems = { FreeSurfer: 'freesurfer' };
const spatialTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:surface', 'neuro:tract']);
const griddedTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map']);
const labelledTypes = new Set(['neuro:label-map']);
const contractSpatialTypes = new Set(['neuro:volume', 'neuro:mask', 'neuro:label-map', 'neuro:surface']);

function mapType(type) {
  if (Array.isArray(type)) return { type: 'core:file' };
  if (artifactTypes.has(type) || type.startsWith('file:')) return { type };
  return aliases[type] ?? { type: `neurodesk:${type.slice(type.indexOf(':') + 1)}` };
}

function parameterType(field) {
  if (field.type !== 'array') return `core:${field.type}`;
  const item = field.items.type === 'array' ? 'core:json' : parameterType(field.items);
  return `core:array<${item}>`;
}

const unique = values => [...new Set(values)];
const allows = (set, type) => type.startsWith('neurodesk:') || set.has(type);

function promoteFormats(formats) {
  return unique(formats.map(token => {
    if (formatTokens.has(token)) return token;
    if (token in formatSpellings) return formatSpellings[token];
    return `neurodesk:${token}`;
  }).filter(Boolean));
}

// The one file input whose space an artifact declared as `input` inherits.
function spatialInput(operation) {
  const roles = Object.entries(operation.inputs)
    .filter(([, field]) => field.source === 'files' && contractSpatialTypes.has(field.type)).map(([role]) => role);
  return roles.length === 1 ? roles[0] : undefined;
}

function promoteSpace(space, kind, operation) {
  if (space === 'native') return 'individual';
  if (kind === 'artifacts') {
    if (space === 'input' || space === 'subject-1mm') {
      const role = spatialInput(operation);
      return role && `inputs.input_${role}`;
    }
    if (space === 'fixed' || space === 'moving') {
      const field = operation.inputs[space];
      return field?.source === 'files' && contractSpatialTypes.has(field.type) ? `inputs.input_${space}` : undefined;
    }
  }
  return vendorSpaces.has(space) ? `neurodesk:${space}` : undefined;
}

// RFC 0010 qualifiers for one declaration, by the RFC's migration mapping.
// A value the mapping does not cover stays in the neurodesk/data extension.
function qualifiers(field, kind, operation, mapped) {
  const result = {};
  const formats = [...(mapped.formats ?? []), ...promoteFormats(field.formats ?? [])];
  if (formats.length) result.formats = unique(formats);
  if (field.space !== undefined && allows(spatialTypes, mapped.type)) {
    const space = promoteSpace(field.space, kind, operation);
    if (space) result.space = space;
    if (space && field.space === 'subject-1mm' && allows(griddedTypes, mapped.type)) result.resolution = 1;
  }
  if (field.labelSystem !== undefined && allows(labelledTypes, mapped.type)) {
    result.labelSystem = labelSystems[field.labelSystem] ?? `neurodesk:${field.labelSystem}`;
  }
  return result;
}

function dataDeclaration(field, description, kind, operation) {
  const mapped = mapType(field.type);
  const scalar = field.source === 'url' ? 'core:string'
    : field.source === 'directory' ? (mapped.type === 'neuro:ome-zarr' ? mapped.type : 'core:directory')
      : mapped.type;
  return {
    type: field.maximum === 1 ? scalar : `core:array<${scalar}>`,
    description,
    optional: field.minimum === 0,
    // A URL is a core:string, which carries no qualifier; its formats stay in the extension.
    ...(scalar !== 'core:string' && qualifiers(field, kind, operation, mapped)),
    extensions: { 'neurodesk/data': structuredClone(field) },
  };
}

const qualifierKeys = ['formats', 'space', 'resolution', 'density', 'labelSystem'];
const qualified = declarations => Object.values(declarations).some(declaration => qualifierKeys.some(key => key in declaration));

// The two RFC 0010 rules the schemas cannot express: a qualified document
// declares 0.1.1, and an inputs.<id> reference names an input of the tool.
function qualifierErrors(tool) {
  const errors = [];
  if ((qualified(tool.inputs ?? {}) || qualified(tool.outputs ?? {})) && tool.neuroflow !== '0.1.1') {
    errors.push(`a document with type qualifiers declares 0.1.1, not ${tool.neuroflow}`);
  }
  for (const [name, declaration] of Object.entries(tool.outputs ?? {})) {
    for (const key of qualifierKeys) {
      const match = /^inputs\.(.+)$/.exec(typeof declaration[key] === 'string' ? declaration[key] : '');
      if (match && !(match[1] in (tool.inputs ?? {}))) errors.push(`outputs/${name}/${key} references undeclared input ${match[1]}`);
    }
  }
  return errors;
}

export function validateTool(tool) {
  if (!validate(tool)) throw new Error(`Invalid NeuroFlow tool: ${ajv.errorsText(validate.errors)}`);
  if (!validateMcp(tool.extensions?.['neuroflow/mcp'])) throw new Error(`Invalid NeuroFlow MCP binding: ${ajv.errorsText(validateMcp.errors)}`);
  const errors = qualifierErrors(tool);
  if (errors.length) throw new Error(`Invalid NeuroFlow tool: ${errors.join('; ')}`);
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
      inputs[name] = dataDeclaration(field, field.description, 'inputs', operation);
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
      outputs[name] = dataDeclaration(field, `${operation.title}: ${role}`, 'artifacts', operation);
    }
    outputs.report = { type: 'neuro:report', description: 'Verified Neurodesk run report, including provenance, measurements and artifact hashes.' };
    const tool = {
      $schema: schemaId, neuroflow: qualified(inputs) || qualified(outputs) ? '0.1.1' : '0.1.0', kind: 'tool',
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

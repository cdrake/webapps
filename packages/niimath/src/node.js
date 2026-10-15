import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runNiimath } from '@neurodesk/node-drivers/niimath';
import createNiimath from '@niivue/niimath/niimath.js';
import packageJson from '../package.json' with { type: 'json' };

const niimathRoot = new URL('./', import.meta.resolve('@niivue/niimath/niimath.js'));
const niimathPackage = JSON.parse(await readFile(new URL('../package.json', niimathRoot), 'utf8'));
export const NIIMATH_VERSION = niimathPackage.version;

// The web app always asks for float output (ImageProcessor's default); -odt overrides it.
const DEFAULT_OUTPUT_TYPE = 'float';

/**
 * What the web app writes for a chain of operations: a mesh, a PNG bitmap or a gzipped NIfTI
 * image. The command line stages its output under the same names, so niimath runs the app's argv.
 */
export function outputKind(operations) {
  if (operations.includes('-mesh')) return { staged: 'mesh.mz3', extension: '.mz3', what: 'a mesh (-mesh)' };
  if (operations.includes('-bitmap')) return { staged: 'bitmap.png', extension: '.png', what: 'a bitmap (-bitmap)' };
  return { staged: 'image.nii.gz', extension: '.nii.gz', what: 'an image' };
}

/**
 * Splits a native niimath command line, `[-dt TYPE] INPUT [OPERATION ...] OUTPUT [-odt TYPE]`,
 * into its parts. The output must carry the extension this WebAssembly build writes.
 */
export function parseCommandLine(argv) {
  const words = [...argv];
  const dt = words[0] === '-dt' ? words.splice(0, 2) : [];
  if (dt.length === 1) throw new Error('-dt needs a datatype: float or double.');
  const odt = words.at(-2) === '-odt' ? words.splice(-2, 2) : ['-odt', DEFAULT_OUTPUT_TYPE];
  if (words.length < 2) throw new Error('Provide an input image, any operations and an output name. Use --help for details.');
  const input = words[0];
  const output = words.at(-1);
  const operations = words.slice(1, -1);
  const kind = outputKind(operations);
  if (!output.toLowerCase().endsWith(kind.extension)) {
    throw new Error(`This niimath build writes ${kind.what} as ${kind.extension}; end the output name ${output} with ${kind.extension}.`);
  }
  return { dt, input, operations, output, odt, kind };
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Staged names keep the file's extension, which tells niimath how to read it.
const stagedName = (index, path) => `__in${index}_${basename(path).replace(/[^A-Za-z0-9._-]/g, '_')}`;

/**
 * The argv and in-memory files for runNiimath: the input and every operation argument that names
 * an existing file are staged by content, the output under the web app's name.
 */
export async function invocation({ dt, input, operations, odt, kind }) {
  if (!await isFile(input)) throw new Error(`Input image ${input} does not exist.`);
  const inputs = {};
  const stage = async (path) => {
    const name = stagedName(Object.keys(inputs).length, path);
    inputs[name] = new Uint8Array(await readFile(path));
    return name;
  };
  const args = [...dt, await stage(input)];
  for (const word of operations) args.push(await isFile(word) ? await stage(word) : word);
  args.push(kind.staged, ...odt);
  return { args, inputs };
}

// The complete file replaces OUTPUT in one step, as native niimath overwrites its output.
async function publish(path, bytes) {
  const partial = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.partial`);
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Runs a native niimath command line through the web app's WebAssembly build. */
export async function runCommandLine(argv) {
  const parsed = parseCommandLine(argv);
  const output = resolve(parsed.output);
  if (!(await stat(dirname(output)).catch(() => null))?.isDirectory()) throw new Error(`The output directory ${dirname(output)} does not exist.`);
  const { args, inputs } = await invocation(parsed);
  const started = performance.now();
  const { outputs, log } = await runNiimath(createNiimath, args, { inputs, outputs: [parsed.kind.staged] });
  await publish(output, outputs[parsed.kind.staged]);
  return {
    output,
    log,
    provenance: {
      app: `niimath command line ${packageJson.version}`,
      niimath: `@niivue/niimath ${NIIMATH_VERSION} WebAssembly`,
      argv: args,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}

/** The operations and their arguments, from the operator list @niivue/niimath ships. */
export async function operationList() {
  const operators = JSON.parse(await readFile(new URL('niimathOperators.json', niimathRoot), 'utf8'));
  return Object.entries(operators).map(([name, { args = [], help = '' }]) => `  -${[name, ...args.map((arg) => `<${arg}>`)].join(' ')}  ${help}`);
}

// A 4^3 float32 NIfTI-1 image with voxel values 0..63 on a 1 mm grid.
function phantom() {
  const bytes = Buffer.alloc(352 + 64 * 4);
  bytes.writeInt32LE(348, 0);
  [3, 4, 4, 4, 1, 1, 1, 1].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  bytes.writeInt16LE(16, 70);
  bytes.writeInt16LE(32, 72);
  [1, 1, 1, 1].forEach((pixdim, i) => bytes.writeFloatLE(pixdim, 76 + 4 * i));
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < 64; i += 1) bytes.writeFloatLE(i, 352 + 4 * i);
  return bytes;
}

/** Runs -add 2 -mul 3 on a phantom inside this runtime; every voxel must equal (v + 2) * 3. */
export async function checkInstallation() {
  const { outputs } = await runNiimath(createNiimath, ['phantom.nii', '-add', '2', '-mul', '3', 'image.nii.gz', '-odt', 'float'], {
    inputs: { 'phantom.nii': new Uint8Array(phantom()) },
    outputs: ['image.nii.gz'],
  });
  const result = gunzipSync(outputs['image.nii.gz']);
  const offset = result.readFloatLE(108);
  for (let i = 0; i < 64; i += 1) {
    const value = result.readFloatLE(offset + 4 * i);
    if (value !== (i + 2) * 3) throw new Error(`niimath failed its phantom check: voxel ${i} is ${value}, expected ${(i + 2) * 3}.`);
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    niimathCommandLine: packageJson.version,
    niimath: NIIMATH_VERSION,
    phantom: '-add 2 -mul 3 exact on 64 voxels',
  };
}

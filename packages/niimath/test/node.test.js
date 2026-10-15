import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseCommandLine } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/niimath.js', import.meta.url));
const niimath = (args, options = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...options });

// A 4^3 float32 NIfTI-1 image whose voxel i holds value(i).
function image(value) {
  const bytes = Buffer.alloc(352 + 64 * 4);
  bytes.writeInt32LE(348, 0);
  [3, 4, 4, 4, 1, 1, 1, 1].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  bytes.writeInt16LE(16, 70);
  bytes.writeInt16LE(32, 72);
  [1, 2, 2, 2].forEach((pixdim, i) => bytes.writeFloatLE(pixdim, 76 + 4 * i));
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  bytes.write('n+1\0', 344, 'latin1');
  for (let i = 0; i < 64; i += 1) bytes.writeFloatLE(value(i), 352 + 4 * i);
  return bytes;
}

function voxels(gzipped) {
  const bytes = gunzipSync(gzipped);
  const offset = bytes.readFloatLE(108);
  const datatype = bytes.readInt16LE(70);
  const read = datatype === 2 ? (i) => bytes.readUInt8(offset + i) : (i) => bytes.readFloatLE(offset + 4 * i);
  return { datatype, values: Array.from({ length: 64 }, (_, i) => read(i)) };
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'niimath-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'subject one.nii.gz');
  const other = join(directory, 'other.nii');
  await writeFile(input, gzipSync(image((i) => i)));
  await writeFile(other, image((i) => 100 - i));
  return { directory, input, other };
}

test('the command line is split as native niimath reads it, with the web app\'s float output by default', () => {
  const plain = parseCommandLine(['in.nii', '-s', '2', 'out.nii.gz']);
  assert.deepEqual([plain.dt, plain.input, plain.operations, plain.output, plain.odt], [[], 'in.nii', ['-s', '2'], 'out.nii.gz', ['-odt', 'float']]);
  assert.equal(plain.kind.staged, 'image.nii.gz');
  const typed = parseCommandLine(['-dt', 'double', 'in.nii', '-bin', 'mask.nii.gz', '-odt', 'char']);
  assert.deepEqual([typed.dt, typed.operations, typed.odt], [['-dt', 'double'], ['-bin'], ['-odt', 'char']]);
  assert.equal(parseCommandLine(['in.nii', '-mesh', '-i', 'm', 'brain.mz3']).kind.staged, 'mesh.mz3');
  assert.equal(parseCommandLine(['in.nii', '-bitmap', '-o', 'x.png', 'slice.PNG']).kind.staged, 'bitmap.png');
  assert.deepEqual(parseCommandLine(['in.nii', 'copy.nii.gz']).operations, []);
});

test('outputs this build cannot write under the given name are refused', () => {
  const cases = [
    [['in.nii'], /Provide an input image/],
    [['-dt'], /-dt needs a datatype/],
    [['in.nii', '-s', '2', 'out.nii'], /writes an image as \.nii\.gz/],
    [['in.nii', '-mesh', '-i', 'm', 'brain.gii'], /writes a mesh \(-mesh\) as \.mz3/],
    [['in.nii', '-bitmap', '-o', 'x.png', 'slice.nii.gz'], /writes a bitmap \(-bitmap\) as \.png/],
  ];
  for (const [argv, message] of cases) assert.throws(() => parseCommandLine(argv), message, argv.join(' '));
});

test('a command writes OUTPUT, prints its path and reports the argv niimath ran', async (t) => {
  const { directory, input, other } = await workspace(t);
  const output = join(directory, 'result.nii.gz');
  const run = niimath([input, '-add', other, '-mul', '3', output], { cwd: directory });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), output);
  const provenance = JSON.parse(run.stderr.trim().split('\n').at(-1));
  assert.deepEqual(provenance.argv, ['__in0_subject_one.nii.gz', '-add', '__in1_other.nii', '-mul', '3', 'image.nii.gz', '-odt', 'float']);
  assert.equal(provenance.niimath, '@niivue/niimath 1.3.2 WebAssembly');
  const result = voxels(await readFile(output));
  assert.equal(result.datatype, 16, 'float output, as in the web app');
  assert.deepEqual(result.values, Array(64).fill(300), 'reads the operation\'s file argument: (i + (100 - i)) * 3');
});

test('-odt sets the output datatype and an existing output is replaced without leftovers', async (t) => {
  const { directory, input } = await workspace(t);
  const output = join(directory, 'result.nii.gz');
  await writeFile(output, 'old');
  const run = niimath([input, '-thr', '32', '-bin', output, '-odt', 'char']);
  assert.equal(run.status, 0, run.stderr);
  const result = voxels(await readFile(output));
  assert.equal(result.datatype, 2, 'unsigned char output');
  assert.deepEqual(result.values, Array.from({ length: 64 }, (_, i) => (i >= 32 ? 1 : 0)));
  assert.deepEqual((await readdir(directory)).sort(), ['other.nii', 'result.nii.gz', 'subject one.nii.gz']);
});

test('invalid inputs fail before anything is written', async (t) => {
  const { directory, input } = await workspace(t);
  const cases = [
    [[join(directory, 'missing.nii'), '-s', '2', join(directory, 'out.nii.gz')], /Input image .*missing\.nii does not exist/],
    [[input, '-s', '2', join(directory, 'absent', 'out.nii.gz')], /output directory .*absent does not exist/],
    [[input, '-s', '2', join(directory, 'out.nii')], /end the output name/],
    [[input, '-nonsense', join(directory, 'out.nii.gz')], /exited with/],
    [['self-check', 'extra'], /self-check does not accept arguments/],
    [['download-models', 'extra'], /download-models accepts only --cache-dir DIR/],
  ];
  for (const [args, message] of cases) {
    const run = niimath(args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, message);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['other.nii', 'subject one.nii.gz']);
});

test('help lists the operations of the pinned build', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const run = niimath(args);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Usage: niimath/);
    assert.match(run.stdout, /\n {2}-s <sigma> {2}/);
    assert.match(run.stdout, /\n {2}-mesh /);
  }
});

test('download-models installs nothing because niimath uses no model files', async (t) => {
  const { directory } = await workspace(t);
  const run = niimath(['download-models', '--cache-dir', join(directory, 'models')]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no model files/);
  assert.deepEqual((await readdir(directory)).sort(), ['other.nii', 'subject one.nii.gz']);
});

test('self-check runs the pinned niimath build on a phantom', () => {
  const run = niimath(['self-check']);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.niimath, '1.3.2');
  assert.equal(report.node, process.version);
});

test('the command line pins the niimath build the web app runs', async () => {
  const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const [cli, app] = await Promise.all([read('../package.json'), read('../../../apps/niimath/package.json')]);
  assert.equal(cli.dependencies['@niivue/niimath'], app.dependencies['@niivue/niimath']);
  assert.match(cli.dependencies['@niivue/niimath'], /^\d+\.\d+\.\d+$/, 'an exact version, so the two cannot drift apart');
  assert.equal(cli.version, app.version);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listSchemas, loadDicompare, readDicomInputs, readSchema } from '../src/node.js';

const bin = fileURLToPath(new URL('../bin/dicompare.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NEURODESK_OFFLINE: '1' } });

test('DICOM inputs are read recursively in sorted order and named as the browser names uploads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dicompare-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'b'));
  await writeFile(join(root, 'b', '2.dcm'), 'two');
  await writeFile(join(root, 'a.dcm'), 'one');
  await writeFile(join(root, '.DS_Store'), 'hidden');
  await writeFile(join(root, 'c.dcm'), 'three');
  const files = await readDicomInputs([root]);
  assert.deepEqual(files.map((file) => file.name), ['0-a.dcm', '1-2.dcm', '2-c.dcm']);
  assert.equal(Buffer.from(files[1].content).toString(), 'two');
  await assert.rejects(readDicomInputs([]), /at least one DICOM/);
});

test('a schema is a file or a library schema, and must be a JSON object', async (t) => {
  const library = await listSchemas();
  assert.ok(library.includes('QSM_Consensus_Guidelines_v1.0'));
  const schema = await readSchema('QSM_Consensus_Guidelines_v1.0');
  assert.equal(schema.name, 'QSM_Consensus_Guidelines_v1.0.json');
  assert.ok(JSON.parse(schema.text).acquisitions);
  const root = await mkdtemp(join(tmpdir(), 'dicompare-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'list.json'), '[]');
  await assert.rejects(readSchema(join(root, 'list.json')), /must be a JSON object/);
  await assert.rejects(readSchema(join(root, 'missing.json')), /neither a file nor a library schema/);
});

test('offline start-up names the missing package instead of downloading it', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'dicompare-empty-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  await assert.rejects(loadDicompare({ cacheDir, offline: true }), /missing from the offline Python directory/);
});

test('the command line rejects options a command does not take', () => {
  const unknown = run('frobnicate');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command frobnicate/);
  const misplaced = run('analyze', 'x.dcm', '--schema', 'a.json');
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stderr, /analyze does not accept --schema/);
  const repeated = run('compare', 'x', '--schema', 'a', '--schema', 'b');
  assert.match(repeated.stderr, /Repeated option --schema/);
  const index = run('compare', 'x', '--schema', 'QSM_Consensus_Guidelines_v1.0', '--schema-index', '1.5');
  assert.match(index.stderr, /nonnegative integer/);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /dicompare compare DICOM\.\.\. --schema SCHEMA/);
  const schemas = run('schemas');
  assert.equal(schemas.status, 0);
  assert.ok(schemas.stdout.split('\n').includes('QSM_Consensus_Guidelines_v1.0'));
});

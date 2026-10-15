import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { niftiBytes } from './nifti-fixture.js';

const bin = fileURLToPath(new URL('../bin/sct-webapp.js', import.meta.url));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sct-webapp-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'input.nii');
  await writeFile(input, Buffer.from(niftiBytes([4, 4, 4], new Float32Array(64).fill(1))));
  return { directory, input };
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NEURODESK_SCT_WEBAPP_MODEL_DIR: '', ...env },
  });
  assert.ifError(result.error);
  return result;
}

test('help, version and the task list', async (t) => {
  const { directory } = await scratch(t);
  assert.match(run(['--help']).stdout, /sct-webapp segment \[--task TASK\] input\.nii\[\.gz\] output-directory/);
  assert.equal(run(['--version']).stdout.trim(), packageJson.version);
  const tasks = run(['tasks', '--cache-dir', join(directory, 'empty')]);
  assert.equal(tasks.status, 0, tasks.stderr);
  assert.deepEqual(JSON.parse(tasks.stdout).map(({ task, installed }) => [task, installed]), [
    ['spinalcord', false], ['graymatter', false], ['lesion_sci_t2', false], ['lesion_ms', false], ['spine', false],
  ]);
  const unknown = run(['segment-all']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown command "segment-all"/);
});

test('a missing model is never downloaded offline and names the download command', async (t) => {
  const { directory, input } = await scratch(t);
  const output = join(directory, 'results');
  const result = run(['segment', '--task', 'spine', input, output, '--cache-dir', join(directory, 'models')], { NEURODESK_OFFLINE: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The spine model \(totalspineseg-step1\.onnx, 538 MB\) is not installed\. Run "sct-webapp download-models --task spine" once while online\./);
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('a model that does not match its pinned SHA-256 is refused', async (t) => {
  const { directory, input } = await scratch(t);
  const models = join(directory, 'models');
  await mkdir(models);
  await writeFile(join(models, 'sct-spinalcord.onnx'), 'tampered');
  const result = run(['segment', input, join(directory, 'results'), '--cache-dir', models, '--offline']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sct-spinalcord\.onnx failed SHA-256 verification/);
});

test('settings are checked and outputs never overwrite files', async (t) => {
  const { directory, input } = await scratch(t);
  const threshold = run(['segment', '--threshold', '0.9', input, join(directory, 'a')]);
  assert.match(threshold.stderr, /threshold must be between 0\.01 and 0\.5/);
  const size = run(['segment', '--minimum-component-size', 'many', input, join(directory, 'b')]);
  assert.match(size.stderr, /--minimum-component-size must be a number/);
  const task = run(['segment', '--task', 'rootlets', input, join(directory, 'c')]);
  assert.match(task.stderr, /Unknown or unsupported task "rootlets"/);
  const busy = join(directory, 'busy');
  await mkdir(busy);
  await writeFile(join(busy, 'keep.txt'), 'x');
  const occupied = run(['segment', input, busy, '--offline', '--cache-dir', join(directory, 'models')]);
  assert.match(occupied.stderr, /Output directory .* is not empty/);
});

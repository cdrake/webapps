// Release check for sct-webapp archives, run as
//   node packages/spinalcordtoolbox/validation/cli-check.mjs --executable PATH
// For each pinned SCT case it runs the command line, holds every mask to the web
// app's parity gates against SCT's own output (apps/spinalcordtoolbox/scripts/
// parity-gates.cjs), and requires every download to be byte-identical to the web
// worker's, which runs here in Node on the same ONNX Runtime CPU backend.
// Without --executable it checks the repository's bin/sct-webapp.js.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getTask } from '../src/tasks.js';
import { CASES, pinnedFile } from './fixtures.mjs';

// The worker reference loads onnxruntime-node in this process; keep it from writing a device ID under HOME.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const require = createRequire(import.meta.url);
const gates = require('../../../apps/spinalcordtoolbox/scripts/parity-gates.cjs');
const { runWorkerCase } = require('../../../apps/spinalcordtoolbox/scripts/test_inference_worker_e2e.cjs');

const { values } = parseArgs({
  options: {
    executable: { type: 'string' },
    // Reuse downloaded models between local runs; a release check starts empty.
    'cache-dir': { type: 'string' },
    case: { type: 'string', multiple: true },
  },
});
const command = values.executable
  ? [await realpath(resolve(values.executable))]
  : [process.execPath, resolve(import.meta.dirname, '../bin/sct-webapp.js')];
const work = await mkdtemp(join(tmpdir(), 'sct-webapp-cli-check-'));
const cacheDir = values['cache-dir'] ? resolve(values['cache-dir']) : join(work, 'models');
const cases = values.case ? CASES.filter(({ id }) => values.case.includes(id)) : CASES;
assert.equal(cases.length, values.case?.length ?? CASES.length, 'every requested case exists');

function run(args, { expectFailure = false, env = {} } = {}) {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (expectFailure) {
    assert.notEqual(result.status, 0, `${args.join(' ')} must fail`);
    return result.stderr;
  }
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// The installation and its refusals.
const selfCheck = run(['self-check', '--cache-dir', cacheDir]);
assert.equal(selfCheck.executionProvider, 'cpu');
assert.deepEqual(selfCheck.tasks.map(({ task }) => task), ['spinalcord', 'graymatter', 'lesion_sci_t2', 'lesion_ms', 'spine']);
if (values.executable) {
  assert.equal(selfCheck.tasks.find(({ task }) => task === 'spinalcord').installed, true, 'the portable release bundles the spinalcord model');
}
console.log(`PASS self-check: Node ${selfCheck.node}, ONNX Runtime ${selfCheck.onnxRuntime}`);

const [firstCase] = cases;
const firstInput = await pinnedFile(firstCase.input);
const emptyCache = join(work, 'empty-cache');
const offline = run(['segment', '--task', 'graymatter', firstInput, join(work, 'refused-offline'), '--cache-dir', emptyCache], {
  expectFailure: true,
  env: { NEURODESK_OFFLINE: '1' },
});
assert.match(offline, /sct-webapp download-models --task graymatter/);
const tampered = join(work, 'tampered-cache');
await mkdir(tampered);
await writeFile(join(tampered, 'sct-graymatter.onnx'), 'not the pinned model');
assert.match(run(['segment', '--task', 'graymatter', firstInput, join(work, 'refused-tampered'), '--cache-dir', tampered], { expectFailure: true }), /failed SHA-256 verification/);
assert.match(run(['segment', '--task', 'rootlets', firstInput, join(work, 'refused-task')], { expectFailure: true }), /Unknown or unsupported task "rootlets"/);
assert.match(run(['segment', '--threshold', '0.9', firstInput, join(work, 'refused-threshold')], { expectFailure: true }), /threshold must be between 0.01 and 0.5/);
console.log('PASS refusals: missing model offline, tampered model, unsupported task, threshold range');

// Models of the selected tasks, verified on download; the bundled one is reused.
const downloaded = run(['download-models', ...cases.flatMap(({ task }) => ['--task', task]), '--cache-dir', cacheDir]);
const modelPaths = new Map(downloaded.models.map(({ task, path }) => [task, path]));

for (const testCase of cases) {
  const input = await pinnedFile(testCase.input);
  const output = join(work, testCase.id, 'cli');
  const report = run(['segment', '--task', testCase.task, input, output, '--cache-dir', cacheDir, '--offline']);
  assert.equal(report.provenance.executionProvider, 'cpu');
  assert.equal(report.provenance.modelSha256, downloaded.models.find(({ task }) => task === testCase.task).sha256);

  // The web app's worker on the same input, model and backend.
  const { messages } = await runWorkerCase({
    id: `${testCase.id}_cli_reference`,
    taskId: testCase.task,
    modelAssetId: getTask(testCase.task).modelAssets[0].id,
    modelName: report.provenance.model,
    inputPath: input,
    expectedStages: Object.keys(testCase.references),
  }, { modelDirectory: dirname(modelPaths.get(testCase.task)) });
  const worker = new Map();
  for (const message of messages.filter((entry) => entry?.type === 'stageData')) {
    if (message.kind === 'metrics') worker.set(message.filename, Buffer.from(message.csv));
    else worker.set(`${message.taskId}_${message.stage}.nii`, Buffer.from(message.niftiData));
  }
  const files = (await readdir(output)).sort();
  assert.deepEqual(files, [...worker.keys()].sort(), `${testCase.id}: the command line writes the web app's downloads`);
  assert.deepEqual(report.files.slice().sort(), files);
  for (const name of files) {
    assert.ok((await readFile(join(output, name))).equals(worker.get(name)), `${testCase.id}/${name} is byte-identical to the web worker's`);
  }
  console.log(`PASS ${testCase.id}: ${files.join(', ')} byte-identical to the web worker (ONNX Runtime CPU)`);

  const referencePaths = {};
  for (const [stage, reference] of Object.entries(testCase.references)) {
    referencePaths[stage] = await pinnedFile(reference);
    const check = gates.CRITICAL_BROWSER_OUTPUTS.find(({ id }) => id === testCase.gates[stage]);
    const stats = gates.assertMaskParity(check, referencePaths[stage], join(output, `${testCase.task}_${stage}.nii`));
    console.log(`PASS ${check.id}: Dice ${stats.dice.toFixed(4)} >= ${check.minDice}, ${stats.producedNz} voxels against SCT's ${stats.expectedNz}`);
  }
  if (testCase.task === 'lesion_sci_t2') {
    const { expected, produced } = gates.assertSciLesionMetrics({
      expectedCord: referencePaths.segmentation,
      expectedLesion: referencePaths.lesion,
      producedCord: join(output, 'lesion_sci_t2_segmentation.nii'),
      producedLesion: join(output, 'lesion_sci_t2_lesion.nii'),
    });
    console.log(`PASS SCIseg lesion metrics: ${produced.lesion_count} lesion(s), ${produced.total_volume_mm3} mm3 against SCT's ${expected.lesion_count}, ${expected.total_volume_mm3} mm3`);
  }
  if (testCase.task === 'lesion_ms') {
    const { expected, produced } = gates.assertMsLesionMetrics({
      expectedLesion: referencePaths.lesion,
      producedLesion: join(output, 'lesion_ms_lesion.nii'),
    });
    console.log(`PASS MS lesion metrics: ${produced.lesion_count} lesion(s) within one of SCT's ${expected.lesion_count}, ${produced.total_volume_mm3} mm3 within 20 % of ${expected.total_volume_mm3} mm3`);
  }
}
console.log(`PASS sct-webapp release check (${cases.map(({ id }) => id).join(', ')}); outputs in ${work}`);

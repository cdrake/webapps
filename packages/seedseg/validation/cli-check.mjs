#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { browserReference, caseParameters } from './browser-reference.mjs';
import { outputNames } from '../src/results.js';
import { MODEL_ASSETS } from '../src/assets.js';
import { createProstateFixture, createProstateSeedMask, PROSTATE_FIXTURE_DIMS, PROSTATE_FIXTURE_SEEDS } from '../../../apps/seedseg/test/prostate-fixture.mjs';
import { markerComponents, matchComponentsToSeeds } from '../../../apps/seedseg/test/marker-components.mjs';
const { values } = parseArgs({ options: { executable: { type: 'string' }, composite: { type: 'boolean' }, case: { type: 'string' } } });
const command = values.executable ? [resolve(values.executable)] : [process.execPath, fileURLToPath(new URL('../bin/seedseg.js', import.meta.url))];
const modelsDirectory = values.executable ? join(dirname(await realpath(values.executable)), 'models') : process.env.NEURODESK_SEEDSEG_MODEL_DIR;
assert.ok(modelsDirectory, 'Source validation requires NEURODESK_SEEDSEG_MODEL_DIR');
const scratch = await mkdtemp(join(tmpdir(), 'seedseg-cli-check-'));
const started = performance.now();
// v2 (nnU-Net networks): the default single network, the 5-network ensemble with changed K and
// threshold, and mirroring. v1 (legacy): ensemble sizes 1-4 with changed top-N and threshold.
const ALL_FOLDS = [0, 1, 2, 3, 4];
const cases = [
  { id: 'v2-fold-0', folds: [0], threshold: 0.1, topN: 3 },
  { id: 'v2-folds-5', folds: ALL_FOLDS, threshold: 0.1, topN: 3 },
  { id: 'v2-top-1', folds: ALL_FOLDS, threshold: 0.1, topN: 1 },
  { id: 'v2-threshold', folds: ALL_FOLDS, threshold: 0.5, topN: 3 },
  { id: 'v2-mirror', folds: [0], mirror: true, threshold: 0.1, topN: 3 },
  ...[1, 2, 3, 4].map(ensemble => ({ id: `ensemble-${ensemble}`, ensemble, threshold: 0.1, topN: 3 })),
  { id: 'top-1', ensemble: 4, threshold: 0.1, topN: 1 }, { id: 'top-2', ensemble: 4, threshold: 0.1, topN: 2 }, { id: 'threshold', ensemble: 4, threshold: 0.5, topN: 3 },
];
const caseArguments = spec => spec.ensemble === undefined
  ? ['--folds', spec.folds.join(','), ...(spec.mirror ? ['--mirror'] : [])]
  : ['--model', 'v1', '--ensemble', String(spec.ensemble)];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const input = join(scratch, 'synthetic-prostate-t1.nii');
  await writeFile(input, createProstateFixture());
  const isolated = join(scratch, 'isolated-home');
  await mkdir(isolated);
  const env = { ...process.env, NEURODESK_OFFLINE: '1', NEURODESK_SEEDSEG_MODEL_DIR: modelsDirectory };
  delete env.CI;
  delete env.ORT_DISABLE_TELEMETRY;
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) env[key] = isolated;
  const failed = (args, pattern) => {
    const run = spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', env, timeout: 30_000 });
    assert.ifError(run.error);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, pattern);
  };
  const guardedOutput = join(scratch, 'guard-output');
  const emptyModels = join(scratch, 'missing-models');
  await mkdir(emptyModels);
  failed([input, guardedOutput, '--model', 'v1', '--ensemble', '5'], /positive integer.*4/);
  failed([input, guardedOutput, '--folds', '5'], /Unknown SeedSeg network/);
  failed([input, guardedOutput, '--ensemble', '2'], /use --folds with v2/);
  failed([input, guardedOutput, '--threshold', 'NaN'], /finite number/);
  failed([input, guardedOutput, '--top-n', '0'], /positive integer/);
  failed([input, guardedOutput, '--cache-dir', emptyModels, '--offline'], /missing.*offline model/);
  failed([input, guardedOutput, '--model', 'v1', '--ensemble', '1', '--cache-dir', emptyModels, '--offline'], /missing.*offline model/);
  await writeFile(join(emptyModels, MODEL_ASSETS[0].filename), 'corrupt checkpoint');
  failed([input, guardedOutput, '--cache-dir', emptyModels, '--offline'], /checksum verification/);
  await assert.rejects(readdir(guardedOutput), { code: 'ENOENT' });
  await mkdir(guardedOutput);
  await writeFile(join(guardedOutput, 'keep.txt'), 'preserve');
  failed([input, guardedOutput], /not empty/);
  assert.equal(await readFile(join(guardedOutput, 'keep.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await readdir(isolated, { recursive: true }), []);
  console.log('PASS actual command: invalid folds/ensemble/threshold/top-N, v1 options with v2, missing/corrupt offline models, nonempty output preservation, clean HOME with CI unset');
  const receipts = [];
  for (const spec of cases.filter(candidate => !values.case || candidate.id === values.case)) {
    const output = join(scratch, spec.id);
    const run = spawnSync(command[0], [...command.slice(1), input, output, ...caseArguments(spec), '--threshold', String(spec.threshold), '--top-n', String(spec.topN), '--threads', '4', '--offline'],
      { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 12 * 60 * 1000 });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    const { parameters, assets } = caseParameters(spec);
    assert.deepEqual(report.models.map(model => model.sha256), assets.map(asset => asset.sha256));
    const web = await browserReference({ modelsDirectory, ...spec, composite: values.composite, screenshots: spec.id === 'v2-folds-5' });
    const names = outputNames(parameters.model, assets.length);
    const markerStage = parameters.model === 'v2' ? 'markers' : 'consensus';
    assert.deepEqual((await readdir(output)).sort(), Object.values(names).sort());
    let maximumProbabilityDifference = 0;
    let markers;
    for (const [stage, name] of Object.entries(names)) {
      const native = await readNifti(await readFile(join(output, name)));
      const browser = await readNifti(web.files[stage]);
      assert.deepEqual(native.dims, PROSTATE_FIXTURE_DIMS);
      assert.deepEqual(native.header.affine, browser.header.affine);
      const range = stage === markerStage ? spec.topN : 1;
      assert.ok(native.data.every(value => Number.isFinite(value) && value >= 0 && value <= range));
      assert.equal(native.data.length, browser.data.length);
      if (stage === markerStage) {
        assert.deepEqual(native.data, browser.data, `${spec.id}: exact native/browser marker mask`);
        markers = native.data;
      } else {
        for (let index = 0; index < native.data.length; index++) maximumProbabilityDifference = Math.max(maximumProbabilityDifference, Math.abs(native.data[index] - browser.data[index]));
      }
    }
    const components = markerComponents(markers, PROSTATE_FIXTURE_DIMS);
    assert.ok(components.length <= spec.topN);
    if (parameters.model === 'v2') {
      // The fixture is 1 mm isotropic and not N4-corrected, off v2's training protocol: v2 finds a
      // subset of the planted seeds (1 with network 1, 2 with all five, measured 2026-10-27).
      // Gate what it reports: at least one marker, each on a distinct planted seed, the count flag
      // and ranks consistent with the native report, and the browser's list equal to it.
      const { detections } = report;
      assert.ok(detections.markers.length >= 1, `${spec.id}: at least one marker`);
      assert.equal(detections.countFlag, detections.nCandidates < spec.topN);
      assert.equal(components.length, detections.markers.length);
      const nearest = components.map(component => PROSTATE_FIXTURE_SEEDS.map((seed, index) => ({ index,
        distance: Math.hypot(...component.centroid.map((value, axis) => value - seed[axis])) })).sort((a, b) => a.distance - b.distance)[0]);
      for (const match of nearest) assert.ok(match.distance <= 1, `${spec.id}: marker within one voxel of planted seed ${match.index}`);
      assert.equal(new Set(nearest.map(match => match.index)).size, nearest.length, `${spec.id}: distinct planted seeds`);
      for (const [rank, marker] of detections.markers.entries()) {
        assert.equal(markers.filter(value => value === rank + 1).length, marker.nVoxels);
      }
      assert.deepEqual(web.measurements.detections.markers.map(marker => marker.nVoxels), detections.markers.map(marker => marker.nVoxels));
    }
    if (spec.id === 'ensemble-4') {
      assert.equal(components.length, 3);
      for (const match of matchComponentsToSeeds(components, PROSTATE_FIXTURE_SEEDS)) assert.ok(match.distance <= 1);
      const planted = createProstateSeedMask();
      const count = planted.reduce((sum, value) => sum + value, 0);
      const recall = planted.reduce((sum, value, index) => sum + (value && markers[index] ? 1 : 0), 0) / count;
      assert.ok(recall >= 0.9);
      assert.ok(markers.reduce((sum, value) => sum + value, 0) <= 10 * count);
      console.log(`PASS independent planted geometry: centroid <= 1 voxel, recall=${recall}, mask <= ${10 * count} voxels`);
    }
    const receipt = { ...spec, nativeSeconds: report.seconds, ortNode: report.onnxRuntime, ortWeb: web.ortWeb, chromium: web.chromium,
      components, maximumProbabilityDifference, maskSha256: sha256(new Uint8Array(markers.buffer)), composite: web.composite };
    receipts.push(receipt);
    console.log(`PASS ${JSON.stringify(receipt)}`);
    assert.deepEqual(await readdir(isolated, { recursive: true }), [], 'No runtime/cache/telemetry writes outside output');
  }
  assert.ok(receipts.length, 'Unknown validation case');
  if (!values.case) {
    for (const [base, ids] of [['ensemble-4', ['top-1', 'top-2', 'threshold']], ['v2-folds-5', ['v2-top-1', 'v2-threshold']], ['v2-fold-0', ['v2-folds-5', 'v2-mirror']]]) {
      const baseline = receipts.find(item => item.id === base);
      for (const id of ids) assert.notEqual(receipts.find(item => item.id === id).maskSha256, baseline.maskSha256, `${id} must change the output`);
    }
  }
  console.log(`PASS SeedSeg offline software parity; elapsed ${(performance.now() - started) / 1000}s. Synthetic fixture, no clinical accuracy claim.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

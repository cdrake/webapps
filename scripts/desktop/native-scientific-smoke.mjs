import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, platform, release, arch, cpus, totalmem, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNifti } from '../../packages/components/src/file-io/NiftiUtils.js';
import { summarizeLabels } from '../../packages/components/src/automation/label-measurements.js';
import freesurferLut from '../../packages/components/src/automation/freesurfer-lut.json' with { type: 'json' };
import { runNativeSynthseg } from '../../packages/desktop/src/native.js';
import { operationFor, parseContract } from '../../packages/desktop/src/contracts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const binary = process.env.NEURODESK_SYNTHSEG_BIN;
if (!binary) throw new Error('Set NEURODESK_SYNTHSEG_BIN to the absolute path of the real native SynthSeg executable.');
const output = resolve(process.env.NEURODESK_SCIENTIFIC_OUTPUT || join(tmpdir(), `neurodesk-native-parity-${Date.now()}`));
await mkdir(output, { recursive: false });
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const packageInfo = JSON.parse(await readFile(join(root, 'apps/synthseg/package.json')));
const contract = operationFor(parseContract({
  ...JSON.parse(await readFile(join(root, 'apps/synthseg/automation.json'))),
  appVersion: packageInfo.version,
}));
const cases = ['fast', 'default'].map(mode => ({
  name: `small_${mode}`,
  mode,
  input: join(root, 'exes/synthseg/test/fixtures/small.nii.gz'),
  golden: join(root, `exes/synthseg/test/fixtures/small_${mode}.nii.gz`),
  limit: 5e-6,
}));
if (process.env.SYNTHSEG_REFERENCE_DIR) {
  for (const stem of ['T1_head', 'T1_head_2mm']) {
    for (const mode of ['fast', 'default']) {
      cases.push({
        name: `${stem}_${mode}`,
        mode,
        input: resolve(process.env.SYNTHSEG_REFERENCE_DIR, `${stem}.nii.gz`),
        golden: resolve(process.env.SYNTHSEG_REFERENCE_DIR, `${stem}_${mode}.nii.gz`),
        limit: 2e-6,
      });
    }
  }
}
const evidence = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  host: { hostname: hostname(), platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem() },
  binary: { path: resolve(binary), sha256: checksum(await readFile(binary)) },
  scope: process.env.SYNTHSEG_REFERENCE_DIR ? 'small fixture and four full-volume cases' : 'small fixture only',
  results: [],
};
const save = () => writeFile(join(output, 'validation.json'), `${JSON.stringify(evidence, null, 2)}\n`);
await save();
try {
  for (const entry of cases) {
    const result = { case: entry.name, limit: entry.limit, pass: false };
    evidence.results.push(result);
    await save();
    const report = await runNativeSynthseg({
      contract,
      request: {
        inputs: { image: [entry.input] },
        parameters: { mode: entry.mode, ct: false },
        engine: 'native',
        timeoutMs: 1800000,
      },
      outputDirectory: join(output, entry.name),
      binary: resolve(binary),
    });
    const actualBytes = await readFile(join(output, entry.name, report.artifacts.labels.filename));
    const goldenBytes = await readFile(entry.golden);
    const actual = await readNifti(actualBytes, Float64Array);
    const golden = await readNifti(goldenBytes, Float64Array);
    assert.deepEqual(actual.dims, golden.dims, `${entry.name}: geometry dimensions`);
    assert.equal(actual.header.xyztUnits, golden.header.xyztUnits, `${entry.name}: NIfTI spatial/time units`);
    const affineError = Math.max(...actual.header.affine.flatMap((row, i) => Array.from(row, (value, j) => Math.abs(value - golden.header.affine[i][j]))));
    assert.ok(affineError <= 1e-4, `${entry.name}: affine error ${affineError}`);
    let mismatches = 0;
    const counts = new Map();
    for (let i = 0; i < actual.data.length; i++) {
      if (actual.data[i] !== golden.data[i]) mismatches++;
      counts.set(actual.data[i], (counts.get(actual.data[i]) || 0) + 1);
    }
    assert.ok(mismatches / actual.data.length <= entry.limit, `${entry.name}: ${mismatches}/${actual.data.length} mismatched voxels`);
    assert.equal(report.artifacts.labels.sha256, checksum(actualBytes));
    const goldenMeasurements = summarizeLabels(golden, freesurferLut);
    assert.ok(goldenMeasurements.voxelVolumeMl > 0);
    assert.ok(Math.abs(report.measurements.voxelVolumeMl - goldenMeasurements.voxelVolumeMl) < 1e-10);
    assert.equal(report.measurements.labels.length, counts.size);
    for (const label of report.measurements.labels) {
      assert.equal(label.voxels, counts.get(label.id));
      assert.ok(Math.abs(label.volumeMl - counts.get(label.id) * report.measurements.voxelVolumeMl) < 1e-9);
    }
    for (const [id, name] of [[17, 'Left-Hippocampus'], [53, 'Right-Hippocampus']]) {
      const label = report.measurements.labels.find(candidate => candidate.id === id);
      if (counts.has(id)) assert.equal(label.name, name);
    }
    const savedReport = JSON.parse(await readFile(join(output, entry.name, 'report.json')));
    assert.deepEqual(savedReport.measurements, report.measurements);
    Object.assign(result, {
      pass: true,
      executionProvider: report.provenance.executionProvider,
      modelSha256: report.provenance.modelSha256,
      inputSha256: (Array.isArray(report.inputs.image) ? report.inputs.image[0] : report.inputs.image).sha256,
      goldenSha256: checksum(goldenBytes),
      outputSha256: report.artifacts.labels.sha256,
      mismatchedVoxels: mismatches,
      comparedVoxels: actual.data.length,
      affineError,
      seconds: report.provenance.seconds,
      hippocampi: report.measurements.labels.filter(label => [17, 53].includes(label.id)),
    });
    await save();
    console.log(`${entry.name} (${result.executionProvider}): ${mismatches}/${actual.data.length} mismatched voxels; report volumes verified`);
  }
  evidence.completedAt = new Date().toISOString();
  evidence.pass = true;
} catch (error) {
  evidence.pass = false;
  evidence.error = error.stack || String(error);
  throw error;
} finally {
  await save();
  console.log(`Scientific evidence: ${join(output, 'validation.json')}`);
}

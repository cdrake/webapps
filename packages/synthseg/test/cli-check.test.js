// Every release-check gate in validation/compare.mjs passes a FreeSurfer golden against itself and fails
// on a golden with one defect.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { summarizeLabels } from '@neurodesk/webapp-components/automation';
import freesurferLut from '@neurodesk/webapp-components/automation/freesurfer-lut' with { type: 'json' };
import { readNifti } from '@neurodesk/webapp-components/file-io';
import { TISSUES, TISSUE_GROUPS, VOLUME_COLUMNS, parseVolumesCsv } from '../src/results.js';
import { compareLabels, compareTissues, compareVolumeTable, compareVolumes, gates } from '../validation/compare.mjs';

const golden = gunzipSync(await readFile(new URL('../../../exes/synthseg/test/fixtures/small_default.nii.gz', import.meta.url)));
const limit = gates.maxMismatchFraction.fixture;
const offset = new DataView(golden.buffer, golden.byteOffset).getFloat32(108, true);

async function report(bytes) {
  return { measurements: summarizeLabels(await readNifti(bytes), freesurferLut) };
}

function failed(checks) {
  return checks.filter(([passed]) => !passed).map(([, line]) => line);
}

function mutate(change) {
  const bytes = Buffer.from(golden);
  change(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes);
  return bytes;
}

// The first labelled voxels, so changing them changes a label's count and leaves the label set alone.
function labelled(view, count) {
  const voxels = [];
  for (let index = 0; voxels.length < count; index++) if (view.getInt32(offset + 4 * index, true) === 2) voxels.push(index);
  return voxels;
}

test('the shared gates only ever tighten the constants parity.rs held before they moved here', () => {
  assert.ok(gates.maxAffineErrorMm <= 1e-4);
  assert.ok(gates.maxQuaternionError <= 1e-4);
  assert.ok(gates.maxMismatchFraction.fixture <= 5e-6);
  assert.ok(gates.maxMismatchFraction.fullVolume <= 2e-6);
  assert.deepEqual(gates.fullVolumes.map(({ input, mode }) => `${input} ${mode}`).sort(), ['T1_head default', 'T1_head fast', 'T1_head_2mm default', 'T1_head_2mm fast']);
});

test('the golden passes every gate against itself', async () => {
  const compared = compareLabels('golden', golden, golden, limit);
  assert.deepEqual(failed(compared.checks), []);
  assert.deepEqual(failed(compareVolumes('golden', await report(golden), compared)), []);
});

test('each gate fails on the defect it guards against', async () => {
  const total = golden.length;
  const cases = [
    ['int32', (view) => view.setInt16(70, 4, true)],
    ['shape', (view) => view.setInt16(42, view.getInt16(42, true) - 1, true)],
    ['sform', (view) => view.setFloat32(280 + 12, view.getFloat32(280 + 12, true) + 0.5, true)],
    ['codes', (view, bytes) => { bytes[254] = 0; }],
    ['xyzt_units', (view, bytes) => { bytes[123] = 1; }],
    ['quaternion', (view) => view.setFloat32(260, view.getFloat32(260, true) + 0.01, true)],
    ['labels', (view) => view.setInt32(offset + 4 * labelled(view, 1)[0], 99, true)],
    ['voxels differ', (view) => { for (const index of labelled(view, 20)) view.setInt32(offset + 4 * index, 3, true); }],
  ];
  for (const [defect, change] of cases) {
    const bytes = mutate(change);
    assert.equal(bytes.length, total);
    const failures = failed(compareLabels('mutated', bytes, golden, limit).checks);
    assert.ok(failures.length > 0, `${defect}: no gate failed`);
    assert.ok(failures.some((line) => line.includes(defect)), `${defect}: failed ${failures.join('; ')}`);
  }
});

test('the report gates fail when its volumes do not describe the label map', async () => {
  const compared = compareLabels('golden', golden, golden, limit);
  const scaled = await report(golden);
  scaled.measurements.voxelVolumeMl *= 8;
  for (const label of scaled.measurements.labels) label.volumeMl *= 8;
  assert.deepEqual(failed(compareVolumes('scaled', scaled, compared)).length, 3, 'unit, per-label and total volume all fail');
  const shifted = await report(golden);
  shifted.measurements.labels[1].volumeMl += 0.01;
  assert.match(failed(compareVolumes('shifted', shifted, compared)).join(';'), /label volumes differ/);
  const dropped = await report(golden);
  dropped.measurements.labels.pop();
  assert.match(failed(compareVolumes('dropped', dropped, compared)).join(';'), /report lists/);
});

test('the volume table gates pass FreeSurfer\'s table and fail each kind of drift', async () => {
  const { volumes } = parseVolumesCsv(await readFile(new URL('fixtures/T1_head_fast_vol.csv', import.meta.url), 'utf8'));
  assert.deepEqual(failed(compareVolumeTable('golden', volumes, volumes)), []);
  const icv = { ...volumes, 'total intracranial': volumes['total intracranial'] * 1.002 };
  assert.match(failed(compareVolumeTable('icv', icv, volumes)).join(';'), /total intracranial/);
  const hippocampus = { ...volumes, 'left hippocampus': volumes['left hippocampus'] * 1.02 };
  assert.match(failed(compareVolumeTable('structure', hippocampus, volumes)).join(';'), /failing left hippocampus/);
  const small = { ...volumes, 'left inferior lateral ventricle': volumes['left inferior lateral ventricle'] + 15 };
  assert.deepEqual(failed(compareVolumeTable('small', small, volumes)), [], 'a small structure may differ by 20 mm³');
  const { csf, ...missing } = volumes;
  assert.ok(csf > 0);
  assert.match(failed(compareVolumeTable('missing', missing, volumes)).join(';'), /columns/);
});

// Hard tissue maps from the golden's labels: each voxel is 1 in its label's tissue, and each structure's soft
// volume is its voxel count (1 mm grid), so the maps and the table agree exactly.
function hardTissues() {
  const view = new DataView(golden.buffer, golden.byteOffset, golden.byteLength);
  const voxels = (golden.length - offset) / 4;
  const labels = Int32Array.from({ length: voxels }, (_, index) => view.getInt32(offset + 4 * index, true));
  const maps = Object.fromEntries(TISSUES.map((tissue) => {
    const bytes = Buffer.from(golden);
    const map = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    map.setInt16(70, 16, true);
    for (let index = 0; index < voxels; index++) map.setFloat32(offset + 4 * index, TISSUE_GROUPS[tissue].includes(labels[index]) ? 1 : 0, true);
    return [tissue, bytes];
  }));
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  // VOLUME_COLUMNS order is post.rs LABELS order; the first column is the total intracranial volume.
  const order = [0, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 41, 42, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60];
  const volumes = Object.fromEntries(VOLUME_COLUMNS.map((column, index) => [column, index ? counts.get(order[index]) ?? 0 : voxels - (counts.get(0) ?? 0)]));
  return { maps, volumes };
}

test('the tissue map gates pass maps that match their labels and fail each kind of defect', () => {
  const { maps, volumes } = hardTissues();
  assert.deepEqual(Object.values(TISSUE_GROUPS).flat().sort((a, b) => a - b), [2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 41, 42, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60]);
  assert.deepEqual(failed(compareTissues('golden', golden, maps, volumes)), []);
  const change = (tissue, edit) => {
    const bytes = Buffer.from(maps[tissue]);
    edit(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { ...maps, [tissue]: bytes };
  };
  const cases = [
    ['float32', change('gm', (view) => view.setInt16(70, 8, true)), volumes],
    ['grid', change('wm', (view) => view.setFloat32(292, view.getFloat32(292, true) + 1, true)), volumes],
    ['outside [0, 1]', change('csf', (view) => view.setFloat32(offset, -0.5, true)), volumes],
    // A white-matter voxel that is also half CSF: GM + WM + CSF = 1.5.
    ['at most', change('csf', (view) => view.setFloat32(offset + 4 * labelled(new DataView(golden.buffer, golden.byteOffset), 1)[0], 0.5, true)), volumes],
    ['grouped soft volumes', maps, { ...volumes, 'left hippocampus': volumes['left hippocampus'] + 1 }],
  ];
  for (const [defect, mutated, table] of cases) {
    const failures = failed(compareTissues('mutated', golden, mutated, table));
    assert.ok(failures.some((line) => line.includes(defect)), `${defect}: failed ${failures.join('; ')}`);
  }
});

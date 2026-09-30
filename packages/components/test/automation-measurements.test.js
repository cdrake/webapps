import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLabels } from '../src/automation/index.js';
import { createNiftiHeaderFromVolume, parseNiftiHeader } from '../src/file-io/NiftiUtils.js';

const lookup = { I: [0, 2], labels: ['Unknown', 'Left-Cerebral-White-Matter'] };
const image = units => ({
  data: new Uint16Array([0, 2, 2, 99]),
  dims: [2, 2, 1],
  header: { affine: [[-2, 1, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0], [0, 0, 0, 1]], xyztUnits: units },
});

test('label volumes use the absolute affine determinant, units and FreeSurfer names', () => {
  const summary = summarizeLabels(image(10), lookup);
  assert.equal(summary.geometry.spatialUnits, 'mm');
  assert.equal(summary.voxelVolumeMl, 0.024);
  assert.deepEqual(summary.labels[1], { id: 2, name: 'Left-Cerebral-White-Matter', voxels: 2, volumeMl: 0.048 });
  assert.equal(summary.labels[2].name, 'Label 99');
  assert.equal(summarizeLabels(image(1), lookup).voxelVolumeMl, 24000000);
  assert.ok(Math.abs(summarizeLabels(image(3), lookup).voxelVolumeMl - 2.4e-11) < 1e-24);
});

test('unknown spatial units report counts without claiming milliliter values', () => {
  const summary = summarizeLabels(image(0), lookup);
  assert.equal(summary.voxelVolumeMl, null);
  assert.match(summary.volumeUnavailable, /unknown spatial units/);
  assert.equal(summary.labels[0].volumeMl, undefined);
});

test('the shared NIfTI parser retains spatial and time unit bits', () => {
  const header = createNiftiHeaderFromVolume({ dims: [2, 2, 1] });
  new DataView(header).setUint8(123, 17);
  assert.equal(parseNiftiHeader(header).xyztUnits, 17);
});

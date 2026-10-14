import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { VOLUME_COLUMNS, parseVolumesCsv, volumesCsv } from '../src/results.js';

// FreeSurfer 8.2.0 mri_synthseg --fast --vol on T1_head (Hugging Face neurodeskorg/webapps 87db4f02).
const freesurfer = await readFile(new URL('fixtures/T1_head_fast_vol.csv', import.meta.url), 'utf8');

test('the volume table has mri_synthseg\'s columns in its order', () => {
  assert.equal(freesurfer.split('\r\n')[0], ['subject', ...VOLUME_COLUMNS].join(','));
});

test('the volume table rewrites FreeSurfer\'s own table byte for byte', () => {
  const { subject, volumes } = parseVolumesCsv(freesurfer);
  assert.equal(subject, 'T1_head');
  assert.equal(volumes['left hippocampus'], 4892.462);
  assert.equal(volumesCsv(subject, volumes), freesurfer);
});

test('whole volumes print with a decimal point, as Python does', () => {
  const volumes = Object.fromEntries(VOLUME_COLUMNS.map((name, index) => [name, index === 0 ? 1500000 : 0.25]));
  const [, row] = volumesCsv('scan', volumes).trim().split('\r\n');
  assert.match(row, /^scan,1500000\.0,0\.25,/);
  assert.equal(row.split(',').length, VOLUME_COLUMNS.length + 1);
});

test('a table without exactly one subject row is refused', () => {
  assert.throws(() => parseVolumesCsv(freesurfer.split('\r\n')[0]), /one header and one subject row/);
  assert.throws(() => parseVolumesCsv(`${freesurfer}${freesurfer.split('\r\n')[1]}\r\n`), /one header and one subject row/);
});

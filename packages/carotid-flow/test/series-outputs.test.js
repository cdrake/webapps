// Series reading, grid refusal and output naming on small in-memory NIfTI files. The command
// line and the web app share these functions, so their downloads depend on exactly this.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createNiftiHeaderFromVolume, readNiftiFrames } from '@neurodesk/webapp-components/file-io';
import { curvesCsv } from '../src/carotid.js';
import { curvesTable, labelImages, measurements, stem, variabilityImage } from '../src/outputs.js';
import { readSeries, readVolume } from '../src/series.js';

const AFFINE = [[-1.5, 0, 0, 30], [0, 1.25, 0, -20], [0, 0, 4, 7], [0, 0, 0, 1]];
const PIXDIMS = [1.5, 1.25, 4];

/** A NIfTI file of float32 frames on an nx × ny × slices grid, frame-major. */
function niftiFile(name, { nx = 3, ny = 2, slices = 1, frames = 4, affine = AFFINE, pixDims = PIXDIMS, gzip = false } = {}, data = ramp(nx * ny * slices * frames)) {
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [4, nx, ny, slices, frames], affine, pixDims } });
  const bytes = Buffer.concat([Buffer.from(header), Buffer.from(Float32Array.from(data).buffer)]);
  return new File([gzip ? gzipSync(bytes) : bytes], name);
}

function ramp(length, offset = 0) {
  return Array.from({ length }, (_, index) => offset + index);
}

function withAffine(change) {
  const affine = AFFINE.map((row) => [...row]);
  change(affine);
  return affine;
}

test('a volume keeps every frame and the stored header, compressed or not', async () => {
  const plain = await readVolume(niftiFile('neck.nii'));
  const compressed = await readVolume(niftiFile('neck.nii.gz', { gzip: true }));
  for (const volume of [plain, compressed]) {
    assert.deepEqual(volume.dims, [3, 2, 1]);
    assert.equal(volume.frames, 4);
    assert.deepEqual(Array.from(volume.data), ramp(24));
    assert.equal(volume.headerBytes.byteLength, 352);
    assert.equal(new DataView(volume.headerBytes).getInt16(42, true), 3);
  }
  assert.deepEqual(new Uint8Array(compressed.headerBytes), new Uint8Array(plain.headerBytes));
});

test('a volume of more than one slice is refused by name', async () => {
  await assert.rejects(readVolume(niftiFile('stack.nii', { slices: 3 })), {
    message: 'stack.nii has 3 slices; Carotid Flow reads one gated slice.',
  });
});

test('a combined series splits into amplitude frames, then phase frames', async () => {
  const series = await readSeries({ combined: niftiFile('neck.nii.gz', { gzip: true }) });
  assert.equal(series.phases, 2);
  assert.deepEqual(Array.from(series.amplitude), ramp(12));
  assert.deepEqual(Array.from(series.phase), ramp(12, 12));
  assert.equal(series.name, 'neck.nii.gz');
  assert.equal(series.nx, 3);
  assert.equal(series.ny, 2);
  assert.deepEqual(series.affine, AFFINE);
  assert.ok(series.affine.every(Array.isArray));
  assert.deepEqual(series.voxelSize, PIXDIMS);
  assert.equal(series.headerBytes.byteLength, 352);
});

test('a combined series needs an even number of at least four frames', async () => {
  await assert.rejects(readSeries({ combined: niftiFile('neck.nii', { frames: 3 }) }), /this series has 3 frames/);
});

test('an amplitude and phase pair is read on the amplitude grid and named after it', async () => {
  const amplitude = niftiFile('neck_mag.nii', { frames: 2 }, ramp(12));
  const phase = niftiFile('neck_ph.nii', { frames: 2 }, ramp(12, 100));
  const series = await readSeries({ amplitude, phase });
  assert.equal(series.phases, 2);
  assert.deepEqual(Array.from(series.amplitude), ramp(12));
  assert.deepEqual(Array.from(series.phase), ramp(12, 100));
  assert.equal(series.name, 'neck_mag.nii');
  assert.equal(series.nx, 3);
  assert.equal(series.ny, 2);
  assert.deepEqual(series.affine, AFFINE);
  assert.deepEqual(series.voxelSize, PIXDIMS);
  assert.equal(series.headerBytes.byteLength, 352);
});

test('a phase image within 1e-5 mm of the amplitude spacing is on the same grid', async () => {
  const amplitude = niftiFile('neck_mag.nii', { frames: 2 }, ramp(12));
  for (const delta of [5e-6, -5e-6]) {
    const pixDims = [PIXDIMS[0], PIXDIMS[1], PIXDIMS[2] + delta];
    const series = await readSeries({ amplitude, phase: niftiFile('neck_ph.nii', { frames: 2, pixDims }) });
    assert.equal(series.phases, 2, String(delta));
  }
});

test('a phase image on another grid is refused, naming both files', async () => {
  const amplitude = niftiFile('neck_mag.nii', { frames: 2 });
  const cases = {
    size: { nx: 2, ny: 3 },
    origin: { affine: withAffine((affine) => { affine[0][3] += 1; }) },
    orientation: { affine: withAffine((affine) => { affine[1][1] = -affine[1][1]; }) },
    'larger first spacing': { pixDims: [1.6, 1.25, 4] },
    'smaller last spacing': { pixDims: [1.5, 1.25, 3.9] },
    'spacing off by 2e-5': { pixDims: [1.5, 1.25 + 2e-5, 4] },
  };
  for (const [label, geometry] of Object.entries(cases)) {
    await assert.rejects(readSeries({ amplitude, phase: niftiFile('neck_ph.nii', { frames: 2, ...geometry }) }), {
      message: 'neck_mag.nii and neck_ph.nii are on different voxel grids (size, orientation, origin or spacing).',
    }, label);
  }
});

test('a phase image with another number of frames is refused', async () => {
  const amplitude = niftiFile('neck_mag.nii', { frames: 2 });
  await assert.rejects(readSeries({ amplitude, phase: niftiFile('neck_ph.nii', { frames: 3 }) }), {
    message: 'neck_mag.nii has 2 frames and neck_ph.nii has 3.',
  });
});

test('a selection error is reported before any file is read', async () => {
  const unreadable = { name: 'neck.nii', arrayBuffer: () => assert.fail('read a file') };
  await assert.rejects(readSeries({ error: 'Choose one phase image.', combined: unreadable }), { message: 'Choose one phase image.' });
});

test('outputs are named after the input without its NIfTI extension', () => {
  const cases = {
    'neck.nii': 'neck',
    'neck.nii.gz': 'neck',
    'NECK.NII.GZ': 'NECK',
    'neck.Nii': 'neck',
    'neck.gz': 'neck',
    'neck.mat': 'neck',
    neck: 'neck',
    'neck.nii.bak': 'neck.nii',
    'neck.nii_old.nii': 'neck',
    'run.v2.nii': 'run',
    'a.b.c': 'a.b',
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(stem(name), expected, name);
});

function readOutput(bytes) {
  const volume = readNiftiFrames(bytes);
  return { datatype: volume.header.datatype, dims: volume.dims, values: Array.from(volume.data), affine: volume.header.affine.map((row) => Array.from(row)) };
}

test('the label map and one mask per side are written on the series grid', async () => {
  const source = await readSeries({ combined: niftiFile('neck.nii.gz', { gzip: true }) });
  const labels = Uint8Array.from([0, 1, 2, 2, 1, 0]);
  const images = labelImages(labels, source);
  assert.deepEqual(Object.keys(images), ['mask', 'left', 'right']);
  assert.equal(images.mask.name, 'neck_carotid_labels.nii');
  assert.equal(images.left.name, 'neck_carotid_left.nii');
  assert.equal(images.right.name, 'neck_carotid_right.nii');
  const expected = { mask: [0, 1, 2, 2, 1, 0], left: [0, 1, 0, 0, 1, 0], right: [0, 0, 1, 1, 0, 0] };
  for (const [key, values] of Object.entries(expected)) {
    assert.deepEqual(readOutput(images[key].bytes), { datatype: 2, dims: [3, 2, 1], values, affine: AFFINE }, key);
  }
});

test('the variability image and the curves table are named after the series', async () => {
  const source = await readSeries({ combined: niftiFile('neck.nii') });
  const found = {
    variability: Float32Array.from([0.5, 1, 1.5, 2, 2.5, 3]),
    left: { curve: [1, 2] },
    right: { curve: [3, 4.5] },
  };
  const image = variabilityImage(found, source);
  assert.equal(image.name, 'neck_phase_sd.nii');
  assert.deepEqual(readOutput(image.bytes), { datatype: 16, dims: [3, 2, 1], values: [0.5, 1, 1.5, 2, 2.5, 3], affine: AFFINE });
  assert.deepEqual(curvesTable(found, source), { name: 'neck_carotid_curves.csv', text: curvesCsv(found) });
  assert.equal(curvesTable(found, source).text, 'frame,left_carotid,right_carotid\n1,1.0000,3.0000\n2,2.0000,4.5000\n');
});

function vessel(offset) {
  return { areaMm2: 10 + offset, pixels: new Array(4 + offset), mean: 1 + offset, peak: 2 + offset, peakFrame: offset, pulsatility: 0.5 + offset, curve: Float64Array.from([1 + offset, 2 + offset]), extra: 'not reported' };
}

function reported(offset) {
  return { areaMm2: 10 + offset, pixelCount: 4 + offset, mean: 1 + offset, peak: 2 + offset, peakFrame: offset, pulsatility: 0.5 + offset, curve: [1 + offset, 2 + offset] };
}

test('measurements report each vessel, in ml/min for velocity', () => {
  const summary = measurements({ method: 'velocity', left: vessel(0), right: vessel(1), velocity: [1] });
  assert.deepEqual(summary, { method: 'velocity', curveUnit: 'ml/min', vessels: { left: reported(0), right: reported(1) } });
  assert.ok(Array.isArray(summary.vessels.left.curve));
});

test('variability measurements carry quality control, in arbitrary units', () => {
  const qc = { tiltDegrees: 20 };
  const summary = measurements({ method: 'variability', qc, baseline: 100, arterialSign: -1, left: vessel(2), right: vessel(3) });
  assert.deepEqual(summary, {
    method: 'variability',
    qc,
    baseline: 100,
    arterialSign: -1,
    curveUnit: 'a.u.',
    vessels: { left: reported(2), right: reported(3) },
  });
  assert.deepEqual(Object.keys(measurements({ method: 'variability', left: vessel(0), right: vessel(0) })), ['method', 'curveUnit', 'vessels']);
});

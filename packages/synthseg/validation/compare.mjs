// A SynthSeg label map and its report against a FreeSurfer 8.1.0 golden, with the gates of
// exes/synthseg/tests/parity.rs (./gates.json). Each check is [passed, line].
import { gunzipSync } from 'node:zlib';
import gates from './gates.json' with { type: 'json' };
import { TISSUES, tissueVolumes } from '../src/results.js';

export { gates };

const QUATERNION_OFFSETS = [76, 256, 260, 264, 268, 272, 276];

/** A NIfTI-1 label map: its 352-byte header, grid and int32 labels. */
export function readLabels(bytes) {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const datatype = view.getInt16(70, true);
  const dims = [1, 2, 3].map((axis) => view.getInt16(40 + 2 * axis, true));
  const affine = [0, 1, 2].map((row) => [0, 1, 2, 3].map((column) => view.getFloat32(280 + 16 * row + 4 * column, true)));
  const offset = view.getFloat32(108, true);
  const data = new Int32Array(dims[0] * dims[1] * dims[2]);
  if (datatype === 8) {
    for (let index = 0; index < data.length; index++) data[index] = view.getInt32(offset + 4 * index, true);
  }
  return { header: raw.subarray(0, 352), view, datatype, dims, affine, data };
}

function counts(data) {
  const result = new Map();
  for (const value of data) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** The label map against the golden: header, grid, value domain and the mismatched-voxel gate. */
export function compareLabels(name, actualBytes, referenceBytes, maxMismatchFraction, against = 'FreeSurfer') {
  const actual = readLabels(actualBytes);
  const reference = readLabels(referenceBytes);
  const checks = [];
  checks.push([actual.datatype === 8, `${name} labels are int32 (datatype ${actual.datatype})`]);
  checks.push([sameList(actual.dims, reference.dims), `${name} shape ${actual.dims.join('x')} (${against} ${reference.dims.join('x')})`]);
  const affineError = Math.max(...actual.affine.flat().map((value, index) => Math.abs(value - reference.affine.flat()[index])));
  checks.push([affineError <= gates.maxAffineErrorMm, `${name} sform differs by ${affineError} mm <= ${gates.maxAffineErrorMm}`]);
  const codes = sameList([...actual.header.subarray(252, 256)], [...reference.header.subarray(252, 256)]);
  checks.push([codes && actual.header[123] === reference.header[123], `${name} qform/sform codes and xyzt_units match ${against}`]);
  const quaternionError = Math.max(...QUATERNION_OFFSETS.map((offset) => Math.abs(actual.view.getFloat32(offset, true) - reference.view.getFloat32(offset, true))));
  checks.push([quaternionError < gates.maxQuaternionError, `${name} quaternion and qfac differ by ${quaternionError} < ${gates.maxQuaternionError}`]);
  const actualLabels = [...counts(actual.data).keys()].sort((a, b) => a - b);
  const referenceLabels = [...counts(reference.data).keys()].sort((a, b) => a - b);
  checks.push([sameList(actualLabels, referenceLabels), `${name} has ${against}'s ${referenceLabels.length} labels (got ${actualLabels.length}: ${actualLabels.join(' ')})`]);
  let mismatched = 0;
  const total = Math.min(actual.data.length, reference.data.length);
  for (let index = 0; index < total; index++) if (actual.data[index] !== reference.data[index]) mismatched++;
  const fraction = actual.data.length === reference.data.length ? mismatched / total : 1;
  checks.push([fraction <= maxMismatchFraction, `${name} ${mismatched} of ${total} voxels differ from ${against} (${fraction.toExponential(2)}) <= ${maxMismatchFraction}`]);
  return { checks, mismatched, reference };
}

/** The report's label volumes against the golden's, which differ by no more than the mismatched voxels. */
export function compareVolumes(name, report, { reference, mismatched }) {
  const [a, b, c] = reference.affine;
  const determinant = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  const voxelVolumeMl = determinant / 1000;
  const measured = report.measurements;
  const checks = [];
  const unitError = Math.abs(measured.voxelVolumeMl - voxelVolumeMl) / voxelVolumeMl;
  checks.push([unitError <= 1e-6, `${name} report voxel volume ${measured.voxelVolumeMl} ml (FreeSurfer grid ${voxelVolumeMl} ml)`]);
  const golden = counts(reference.data);
  checks.push([measured.labels.length === golden.size, `${name} report lists ${measured.labels.length} labels (FreeSurfer ${golden.size})`]);
  let largestError = 0;
  let brainMl = 0;
  let goldenBrainMl = 0;
  for (const [id, voxels] of golden) {
    const row = measured.labels.find((label) => label.id === id) ?? { voxels: 0, volumeMl: 0 };
    largestError = Math.max(largestError, Math.abs(row.volumeMl - voxels * voxelVolumeMl));
    if (id !== 0) {
      brainMl += row.volumeMl;
      goldenBrainMl += voxels * voxelVolumeMl;
    }
  }
  const allowedMl = (mismatched + 1e-6) * voxelVolumeMl;
  checks.push([largestError <= allowedMl, `${name} report label volumes differ from FreeSurfer's by at most ${largestError.toFixed(4)} ml <= ${mismatched} voxels`]);
  checks.push([Math.abs(brainMl - goldenBrainMl) <= allowedMl, `${name} labelled volume ${brainMl.toFixed(3)} ml (FreeSurfer ${goldenBrainMl.toFixed(3)} ml)`]);
  return checks;
}

/** Soft volumes (mri_synthseg --vol columns, mm³) against FreeSurfer's table for the same input and mode. */
export function compareVolumeTable(name, actual, reference) {
  const limits = gates.volumes;
  const checks = [];
  const columns = Object.keys(reference);
  checks.push([sameList(Object.keys(actual), columns), `${name} volume table has FreeSurfer's ${columns.length} columns`]);
  const icv = Math.abs(actual['total intracranial'] - reference['total intracranial']) / reference['total intracranial'];
  checks.push([icv <= limits.maxIcvRelativeError, `${name} total intracranial volume differs from FreeSurfer's by ${(100 * icv).toFixed(4)} % <= ${100 * limits.maxIcvRelativeError} %`]);
  let worst = { column: '', relative: 0, absolute: 0 };
  const failing = [];
  for (const column of columns.filter((entry) => entry !== 'total intracranial')) {
    const absolute = Math.abs(actual[column] - reference[column]);
    const relative = absolute / reference[column];
    if (relative > worst.relative) worst = { column, relative, absolute };
    if (!(relative <= limits.maxRelativeError || absolute <= limits.maxAbsoluteErrorMm3)) failing.push(column);
  }
  const largest = `${worst.column} ${(100 * worst.relative).toFixed(4)} %, ${worst.absolute.toFixed(3)} mm³`;
  checks.push([failing.length === 0, `${name} structure volumes within ${100 * limits.maxRelativeError} % or ${limits.maxAbsoluteErrorMm3} mm³ of FreeSurfer's (largest ${largest}${failing.length ? `; failing ${failing.join(', ')}` : ''})`]);
  return checks;
}

/** float32 voxels of a NIfTI-1 image. */
function readFloats({ view, dims }) {
  const offset = view.getFloat32(108, true);
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let index = 0; index < data.length; index++) data[index] = view.getFloat32(offset + 4 * index, true);
  return data;
}

/**
 * The GM, WM and CSF maps against their own label map and soft volumes (mri_synthseg --vol columns, mm³):
 * float32 on the label grid with the label header's geometry, probabilities whose sum is at most 1, and
 * totals that equal the summed soft volumes of each tissue's structures. No independent golden exists.
 */
export function compareTissues(name, labelBytes, tissueBytes, volumes) {
  const limits = gates.tissues;
  const labels = readLabels(labelBytes);
  const maps = Object.fromEntries(TISSUES.map((tissue) => [tissue, readLabels(tissueBytes[tissue])]));
  const checks = [];
  // Header bytes outside datatype (70-71) and description (148-227) equal the label map's.
  const geometry = (header) => [...header.subarray(0, 70), ...header.subarray(72, 148), ...header.subarray(228, 352)];
  for (const tissue of TISSUES) {
    const map = maps[tissue];
    checks.push([map.datatype === 16, `${name} ${tissue} map is float32 (datatype ${map.datatype})`]);
    checks.push([sameList(geometry(map.header), geometry(labels.header)), `${name} ${tissue} map has the label map's grid and header geometry`]);
  }
  const data = Object.fromEntries(TISSUES.map((tissue) => [tissue, readFloats(maps[tissue])]));
  const sums = Object.fromEntries(TISSUES.map((tissue) => [tissue, 0]));
  let outside = 0;
  let largestSum = 0;
  for (let index = 0; index < labels.data.length; index++) {
    let total = 0;
    for (const tissue of TISSUES) {
      const value = data[tissue][index];
      if (!(value >= 0 && value <= 1)) outside++;
      sums[tissue] += value;
      total += value;
    }
    largestSum = Math.max(largestSum, total);
  }
  checks.push([outside === 0, `${name} tissue maps have ${outside} values outside [0, 1]`]);
  checks.push([largestSum <= 1 + limits.maxProbabilitySumExcess, `${name} GM + WM + CSF is at most ${largestSum} <= 1 + ${limits.maxProbabilitySumExcess}`]);
  // The volumes use the product of the voxel axis lengths, as post.rs voxel_mm3 does.
  const voxelMm3 = [0, 1, 2].reduce((product, axis) => product * Math.hypot(...labels.affine.map((row) => row[axis])), 1);
  const expected = tissueVolumes(volumes);
  for (const tissue of TISSUES) {
    const actual = sums[tissue] * voxelMm3;
    const error = Math.abs(actual - expected[tissue]);
    const passed = error <= limits.maxVolumeErrorMm3 || error <= limits.maxVolumeRelativeError * expected[tissue];
    checks.push([passed, `${name} ${tissue} map sums to ${actual.toFixed(3)} mm³ (grouped soft volumes ${expected[tissue].toFixed(3)} mm³)`]);
  }
  return checks;
}

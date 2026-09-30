import { readVolume } from '../../synthsr/src/volume.js';
import { matrixToAxisAngle, transformPoint } from './registration/geometry.js';

const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const quantile = (values, q) => {
  const index = (values.length - 1) * q;
  const lower = Math.floor(index);
  return values[lower] + (values[Math.min(lower + 1, values.length - 1)] - values[lower]) * (index - lower);
};

export function decodeStacks(stacks) {
  return stacks.map((stack) => {
    const image = readVolume(stack.image);
    const supplied = stack.mask ? readVolume(stack.mask) : null;
    if (supplied && (image.dims.some((d, i) => d !== supplied.dims[i]) || image.affine.some((row, i) => row.some((v, j) => Math.abs(v - supplied.affine[i][j]) > 1e-4)))) throw new Error('Each mask must have the same dimensions and affine as its stack.');
    const resolution = [0, 1, 2].map((c) => Math.hypot(...image.affine.slice(0, 3).map((r) => r[c])));
    const columns = resolution.map((s, c) => image.affine.slice(0, 3).map((r) => r[c] / s));
    if (resolution.some((v) => !(v > 0)) || Math.abs(dot(columns[0], columns[1])) > 1e-5 || Math.abs(dot(columns[0], columns[2])) > 1e-5 || Math.abs(dot(columns[1], columns[2])) > 1e-5) throw new Error('Rigid slices require orthogonal NIfTI axes. Resample sheared inputs before reconstruction.');
    const reverse = dot(cross(columns[0], columns[1]), columns[2]) < 0;
    if (reverse) columns[0] = columns[0].map((v) => -v);
    const [nx, ny, nz] = image.dims;
    const data = new Float32Array(image.data.length);
    const mask = new Uint8Array(data.length);
    const transforms = new Float64Array(nz * 12);
    for (let z = 0; z < nz; z++) {
      const voxel = [(nx - 1) / 2, (ny - 1) / 2, z];
      const center = image.affine.slice(0, 3).map((r) => dot(r.slice(0, 3), voxel) + r[3]);
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) transforms[z * 12 + a * 4 + b] = columns[b][a];
        transforms[z * 12 + a * 4 + 3] = dot(columns[a], center);
      }
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const target = x + nx * (y + ny * z);
          const source = (reverse ? nx - 1 - x : x) + nx * (y + ny * z);
          data[target] = image.data[source];
          mask[target] = (supplied ? supplied.data[source] > 0 : data[target] > 0) ? 1 : 0;
        }
      }
    }
    const affine = image.affine.map((row) => [...row]);
    if (reverse) {
      for (let axis = 0; axis < 3; axis++) {
        affine[axis][3] += affine[axis][0] * (nx - 1);
        affine[axis][0] *= -1;
      }
    }
    return { data, mask, shape: image.dims, dims: image.dims, affine, resolution, thickness: stack.thickness, transforms };
  });
}

export function prepareTraining(stacks, { maxObservations = 16_777_216, spatialScaling = 30 } = {}) {
  const observations = [];
  const poses = [];
  const resolutions = [];
  const matrices = [];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let maxResolution = 0;
  for (const stack of stacks) {
    const values = Array.from(stack.data).filter((_, i) => stack.mask[i]).sort((a, b) => a - b);
    if (!values.length) continue;
    if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error('Masked tissue intensities must be finite and nonnegative.');
    const scale = quantile(values, 0.99);
    if (!(scale > 0)) throw new Error('Masked stack has no positive tissue intensities.');
    const resolution = [...stack.resolution.slice(0, 2), stack.thickness];
    maxResolution = Math.max(maxResolution, ...resolution);
    const sigma = resolution.map((v, axis) => v * (axis < 2 ? 1.206709128803223 : 1) / (2 * Math.sqrt(2 * Math.log(2))) / spatialScaling);
    const [nx, ny, nz] = stack.shape;
    for (let z = 0; z < nz; z++) {
      if (!stack.mask.subarray(z * nx * ny, (z + 1) * nx * ny).some(Boolean)) continue;
      const matrix = stack.transforms.slice(z * 12, (z + 1) * 12);
      const pose = matrixToAxisAngle(matrix);
      const slice = poses.length / 6;
      poses.push(...pose.slice(0, 3), ...pose.slice(3).map((v) => v / spatialScaling));
      resolutions.push(...resolution);
      matrices.push(matrix);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const index = x + nx * (y + ny * z);
          if (!stack.mask[index]) continue;
          const local = [(x - (nx - 1) / 2) * resolution[0], (y - (ny - 1) / 2) * resolution[1], 0];
          transformPoint(matrix, local).forEach((v, axis) => {
            minimum[axis] = Math.min(minimum[axis], v);
            maximum[axis] = Math.max(maximum[axis], v);
          });
          observations.push({ slice, xyz: local.map((v) => v / spatialScaling), target: stack.data[index] / scale, sigma });
          if (observations.length > maxObservations) throw new Error(`The acquisition exceeds the configured memory limit of ${maxObservations} masked observations.`);
        }
      }
    }
  }
  if (!observations.length) throw new Error('No tissue remains after masking.');
  const values = observations.map((o) => o.target).sort((a, b) => a - b);
  const low = quantile(values, 0.1);
  const high = quantile(values, 0.9);
  let sum = 0;
  let count = 0;
  for (const value of values) if (value > low && value < high) { sum += value; count++; }
  if (!count) throw new Error('Tissue intensity variation is required to estimate the reconstruction scale.');
  const center = minimum.map((v, i) => (v + maximum[i]) / 2);
  matrices.forEach((m, slice) => {
    for (let axis = 0; axis < 3; axis++) poses[slice * 6 + axis + 3] -= center.reduce((v, x, i) => v + m[i * 4 + axis] * x, 0) / spatialScaling;
  });
  return {
    observations, poses, resolutions: Float32Array.from(resolutions), center, mean: sum / count,
    boundingBox: [minimum.map((v, i) => (v - center[i] - 2 * maxResolution) / spatialScaling), maximum.map((v, i) => (v - center[i] + 2 * maxResolution) / spatialScaling)],
  };
}

import { checkedSize } from './support.js';

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const gaussianFwhm = 1 / (2 * Math.sqrt(2 * Math.log(2)));
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

export function voxelWorld(volume, index) {
  const voxel = [index % volume.dims[0], Math.floor(index / volume.dims[0]) % volume.dims[1], Math.floor(index / (volume.dims[0] * volume.dims[1]))];
  return volume.affine.slice(0, 3).map((row) => row[3] + row[0] * voxel[0] + row[1] * voxel[1] + row[2] * voxel[2]);
}

function invert3(matrix) {
  const [a, b, c] = matrix[0];
  const [d, e, f] = matrix[1];
  const [g, h, i] = matrix[2];
  const cofactors = [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]];
  const determinant = a * cofactors[0][0] + b * cofactors[1][0] + c * cofactors[2][0];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('Output affine must be invertible.');
  return cofactors.map((row) => row.map((v) => v / determinant));
}

function multiply(matrix, vector) {
  return matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

export function volumeSampler(volume) {
  const inverse = invert3(volume.affine.slice(0, 3).map((row) => row.slice(0, 3)));
  return (world) => {
    const voxel = multiply(inverse, world.map((v, i) => v - volume.affine[i][3]));
    const base = voxel.map(Math.floor);
    const fraction = voxel.map((v, i) => v - base[i]);
    let value = 0;
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          const p = [base[0] + x, base[1] + y, base[2] + z];
          if (p.some((v, axis) => v < 0 || v >= volume.dims[axis])) continue;
          const weight = (x ? fraction[0] : 1 - fraction[0]) * (y ? fraction[1] : 1 - fraction[1]) * (z ? fraction[2] : 1 - fraction[2]);
          value += weight * volume.data[p[0] + volume.dims[0] * (p[1] + volume.dims[1] * p[2])];
        }
      }
    }
    return value;
  };
}

/** Volume.resample uses only the requested orientation's rotation. Its center is
 * recomputed from occupied support, padded by ten new-resolution voxels. */
export async function resampleSupportMask(volume, resolution, { rotation = identity, maxVoxels, signal } = {}) {
  if (!(resolution > 0) || !Number.isFinite(resolution)) throw new Error('Output resolution must be finite and positive.');
  const inverseRotation = invert3(rotation);
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let occupied = 0;
  for (let i = 0; i < volume.mask.length; i++) {
    if (!volume.mask[i]) continue;
    occupied++;
    const point = multiply(inverseRotation, voxelWorld(volume, i));
    point.forEach((v, axis) => {
      minimum[axis] = Math.min(minimum[axis], v);
      maximum[axis] = Math.max(maximum[axis], v);
    });
  }
  if (!occupied) throw new Error('Reconstructed support mask is empty at the upstream occupancy threshold.');
  const origin = minimum.map((v) => v - 10 * resolution);
  const dims = origin.map((v, i) => Math.ceil((maximum[i] + 10 * resolution - v) / resolution));
  const center = multiply(rotation, origin);
  const affine = rotation.map((row, axis) => [...row.map((v) => v * resolution), center[axis]]);
  affine.push([0, 0, 0, 1]);
  const data = new Float32Array(checkedSize(dims, maxVoxels));
  const mask = new Uint8Array(data.length);
  const output = { data, mask, dims, affine, resolution: [resolution, resolution, resolution] };
  const sample = volumeSampler(volume);
  for (let i = 0; i < data.length; i++) {
    data[i] = sample(voxelWorld(output, i));
    mask[i] = data[i] > 0 ? 1 : 0;
    if (i % 65_536 === 0) {
      signal?.throwIfAborted();
      await pause();
    }
  }
  signal?.throwIfAborted();
  return output;
}

export function gaussianRandom(random = Math.random) {
  let spare;
  return () => {
    if (spare !== undefined) {
      const result = spare;
      spare = undefined;
      return result;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    const angle = 2 * Math.PI * random();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

/** evaluate receives packed scanner/world xyz in mm and returns one density per
 * point. The adapter owns the model's centering/scaling, never this sampler. */
export async function sampleWorldPoints(xyz, evaluate, { psfResolution = 0, nSamples = 128, batchSize = 1024, normal = gaussianRandom(), signal, maxSamplePoints = 16_777_216 } = {}) {
  if (xyz.length % 3 || !Number.isFinite(psfResolution) || !Number.isSafeInteger(nSamples) || nSamples < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid output sampling configuration.');
  const count = psfResolution > 0 && nSamples > 1 ? nSamples : 1;
  const sigma = Math.fround(psfResolution * gaussianFwhm);
  const output = new Float32Array(xyz.length / 3);
  for (let start = 0; start < output.length; start += batchSize) {
    signal?.throwIfAborted();
    const size = Math.min(batchSize, output.length - start);
    const points = new Float32Array(checkedSize([size, count, 3], maxSamplePoints));
    for (let i = 0; i < size; i++) {
      for (let sample = 0; sample < count; sample++) {
        for (let axis = 0; axis < 3; axis++) points[(i * count + sample) * 3 + axis] = Math.fround(xyz[(start + i) * 3 + axis]) + (count > 1 ? Math.fround(normal() * sigma) : 0);
      }
    }
    const values = await evaluate(points, { signal });
    if (values.length !== size * count) throw new Error('Model returned a different number of density samples.');
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let sample = 0; sample < count; sample++) sum += values[i * count + sample];
      output[start + i] = sum / count;
      if (!Number.isFinite(output[start + i])) throw new Error('Model returned non-finite output density.');
    }
    await pause();
  }
  signal?.throwIfAborted();
  return output;
}

export async function sampleMaskedVolume(volume, evaluate, { onProgress = () => {}, batchSize = 1024, normal = gaussianRandom(), ...options } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Output batch size must be a positive integer.');
  const data = new Float32Array(volume.mask.length);
  const total = volume.mask.reduce((sum, value) => sum + Number(value !== 0), 0);
  let completed = 0;
  let cursor = 0;
  while (cursor < volume.mask.length) {
    options.signal?.throwIfAborted();
    const indices = [];
    while (cursor < volume.mask.length && indices.length < batchSize) {
      if (volume.mask[cursor]) indices.push(cursor);
      cursor++;
    }
    if (!indices.length) break;
    const xyz = new Float32Array(indices.length * 3);
    indices.forEach((index, i) => xyz.set(voxelWorld(volume, index), i * 3));
    const values = await sampleWorldPoints(xyz, evaluate, { ...options, batchSize, normal });
    indices.forEach((index, i) => { data[index] = values[i]; });
    completed += indices.length;
    onProgress({ completed, total });
  }
  options.signal?.throwIfAborted();
  return { ...volume, data };
}

// A susceptibility map's fingerprint, small enough to commit, and its comparison with another map's.
import { createHash } from 'node:crypto';

// 10-voxel blocks: about 2,700 inside a 1 mm brain, enough to place a regional difference.
export const BLOCK = 10;
const PERCENTILES = [1, 5, 25, 50, 75, 95, 99];
// A block is compared when at least half its voxels hold susceptibility values in both maps.
const MIN_BLOCK_VOXELS = BLOCK ** 3 / 2;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * `chi`, `mask` and `support` are NIfTI volumes' data. The support is the eroded mask the
 * inversion ran in: the web app leaves zeros outside it, so its default is where chi is nonzero.
 * QSMxT's referencing shifts the whole brain mask, so its support is the background-removal mask.
 */
export function measure({ dims, chi, mask, support = null }) {
  const [nx, ny, nz] = dims;
  const count = nx * ny * nz;
  if (chi.length < count || mask.length < count) throw new Error(`volume shorter than ${dims.join('x')}`);
  const maskBytes = new Uint8Array(count);
  const values = [];
  const [bx, by, bz] = [nx, ny, nz].map((size) => Math.ceil(size / BLOCK));
  const sums = new Float64Array(bx * by * bz);
  const counts = new Uint32Array(bx * by * bz);
  for (let z = 0, index = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, index++) {
        maskBytes[index] = mask[index] > 0.5 ? 1 : 0;
        const value = chi[index];
        if (!Number.isFinite(value)) throw new Error(`non-finite susceptibility at voxel ${index}`);
        if (support ? !(support[index] > 0.5) : value === 0) continue;
        values.push(value);
        const block = Math.floor(x / BLOCK) + bx * (Math.floor(y / BLOCK) + by * Math.floor(z / BLOCK));
        sums[block] += value;
        counts[block] += 1;
      }
    }
  }
  const sorted = Float64Array.from(values).sort();
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const quantile = (p) => sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
  const float32 = Float32Array.from(chi.subarray ? chi.subarray(0, count) : chi.slice(0, count));
  return {
    dims: [nx, ny, nz],
    mask: { voxels: maskBytes.reduce((sum, value) => sum + value, 0), sha256: sha256(maskBytes) },
    chi: {
      float32Sha256: sha256(new Uint8Array(float32.buffer)),
      support: values.length,
      meanPpm: round(mean),
      sdPpm: round(sd),
      percentilesPpm: Object.fromEntries(PERCENTILES.map((p) => [`p${p}`, round(quantile(p))])),
    },
    // Mean susceptibility per block in parts per billion, null where too few voxels hold values.
    blocks: {
      size: BLOCK,
      grid: [bx, by, bz],
      meanPpb: Array.from(sums, (sum, block) => (counts[block] >= MIN_BLOCK_VOXELS ? Math.round((sum / counts[block]) * 1000) : null)),
    },
  };
}

const round = (value) => Number(value.toFixed(6));

/** Agreement between two fingerprints of the same input. */
export function compare(reference, candidate) {
  if (JSON.stringify(reference.dims) !== JSON.stringify(candidate.dims)) throw new Error(`dimensions ${candidate.dims} differ from ${reference.dims}`);
  if (JSON.stringify(reference.blocks.grid) !== JSON.stringify(candidate.blocks.grid)) throw new Error('block grids differ');
  const pairs = [];
  reference.blocks.meanPpb.forEach((value, block) => {
    const other = candidate.blocks.meanPpb[block];
    if (value !== null && other !== null) pairs.push([value / 1000, other / 1000]);
  });
  const blocks = reference.blocks.meanPpb.filter((value) => value !== null).length;
  const meanOf = (index) => pairs.reduce((sum, pair) => sum + pair[index], 0) / pairs.length;
  const [ma, mb] = [meanOf(0), meanOf(1)];
  let covariance = 0;
  let va = 0;
  let vb = 0;
  let squared = 0;
  let largest = 0;
  for (const [a, b] of pairs) {
    covariance += (a - ma) * (b - mb);
    va += (a - ma) ** 2;
    vb += (b - mb) ** 2;
    squared += (a - b) ** 2;
    largest = Math.max(largest, Math.abs(a - b));
  }
  const percentileDifference = Math.max(...Object.keys(reference.chi.percentilesPpm).map((key) => Math.abs(reference.chi.percentilesPpm[key] - candidate.chi.percentilesPpm[key])));
  return {
    identical: reference.chi.float32Sha256 === candidate.chi.float32Sha256,
    maskVoxelRatio: round(candidate.mask.voxels / reference.mask.voxels),
    supportRatio: round(candidate.chi.support / reference.chi.support),
    blocksCompared: round(pairs.length / blocks),
    blockCorrelation: round(covariance / Math.sqrt(va * vb)),
    blockRmsPpm: round(Math.sqrt(squared / pairs.length)),
    blockMaxAbsPpm: round(largest),
    meanDifferencePpm: round(Math.abs(candidate.chi.meanPpm - reference.chi.meanPpm)),
    sdRatio: round(candidate.chi.sdPpm / reference.chi.sdPpm),
    percentileMaxAbsPpm: round(percentileDifference),
  };
}

/** Failures of `metrics` against `tolerance`, whose entries are `{ min, max }` bounds. */
export function violations(metrics, tolerance) {
  return Object.entries(tolerance).flatMap(([name, { min = -Infinity, max = Infinity }]) => {
    const value = metrics[name];
    return value >= min && value <= max ? [] : [`${name} ${value} outside [${min}, ${max}]`];
  });
}

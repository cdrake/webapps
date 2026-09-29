// FLAMeS inference around a patch runner. Pure: no DOM, no ONNX Runtime.
//
// Arrays use nnU-Net's axis order: a NIfTI volume with x fastest is read as a
// C-order array of shape [nz, ny, nx], and spacing follows the same order. nnU-Net
// never reorients, so neither do we.

export const PLAN = Object.freeze({
  patch: Object.freeze([112, 128, 160]),
  spacing: Object.freeze([1, 0.9, 0.9]),
  step: 0.5,
});

const product = (shape) => shape[0] * shape[1] * shape[2];

export function arrayGrid(volume) {
  const [nx, ny, nz] = volume.dims;
  const spacing = [0, 1, 2].map((axis) => Math.hypot(volume.affine[0][axis], volume.affine[1][axis], volume.affine[2][axis]));
  return { shape: [nz, ny, nx], spacing: [spacing[2], spacing[1], spacing[0]] };
}

// Bounding box of the brain mask, as nnU-Net's crop_to_nonzero.
export function brainBox(mask, shape) {
  const lo = [...shape];
  const hi = [-1, -1, -1];
  let i = 0;
  for (let z = 0; z < shape[0]; z++) {
    for (let y = 0; y < shape[1]; y++) {
      for (let x = 0; x < shape[2]; x++, i++) {
        if (!mask[i]) continue;
        const c = [z, y, x];
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], c[a]);
          hi[a] = Math.max(hi[a], c[a] + 1);
        }
      }
    }
  }
  if (hi[0] < 0) throw new Error('The brain mask is empty.');
  return { lo, hi, shape: hi.map((h, a) => h - lo[a]) };
}

export function cropVolume(data, shape, box) {
  const out = new Float32Array(product(box.shape));
  let o = 0;
  for (let z = box.lo[0]; z < box.hi[0]; z++) {
    for (let y = box.lo[1]; y < box.hi[1]; y++) {
      const start = (z * shape[1] + y) * shape[2];
      out.set(data.subarray(start + box.lo[2], start + box.hi[2]), o);
      o += box.shape[2];
    }
  }
  return out;
}

// Z-score inside the brain, zero outside: nnU-Net's ZScoreNormalization with use_mask_for_norm.
export function normalizeInBrain(image, inside) {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < image.length; i++) {
    if (inside[i]) {
      n++;
      sum += image[i];
    }
  }
  const mean = sum / n;
  let squares = 0;
  for (let i = 0; i < image.length; i++) {
    if (inside[i]) squares += (image[i] - mean) ** 2;
  }
  const std = Math.max(Math.sqrt(squares / n), 1e-8);
  const out = new Float32Array(image.length);
  for (let i = 0; i < image.length; i++) out[i] = inside[i] ? (image[i] - mean) / std : 0;
  return out;
}

export function targetShape(shape, spacing, target = PLAN.spacing) {
  return shape.map((n, a) => Math.round(n * spacing[a] / target[a]));
}

// Trilinear resize with voxel-centre alignment and edge clamping
// (scipy.ndimage.zoom with order=1, grid_mode=True, mode='nearest').
export function resize(data, shape, newShape) {
  const axes = [0, 1, 2].map((a) => {
    const n = newShape[a];
    const i0 = new Int32Array(n);
    const i1 = new Int32Array(n);
    const w = new Float32Array(n);
    const scale = shape[a] / n;
    for (let o = 0; o < n; o++) {
      const c = Math.min(Math.max((o + 0.5) * scale - 0.5, 0), shape[a] - 1);
      i0[o] = Math.floor(c);
      i1[o] = Math.min(i0[o] + 1, shape[a] - 1);
      w[o] = c - i0[o];
    }
    return { i0, i1, w };
  });
  const [Z, Y, X] = axes;
  const plane = shape[1] * shape[2];
  const out = new Float32Array(product(newShape));
  let o = 0;
  for (let z = 0; z < newShape[0]; z++) {
    const z0 = Z.i0[z] * plane;
    const z1 = Z.i1[z] * plane;
    const wz = Z.w[z];
    for (let y = 0; y < newShape[1]; y++) {
      const y0 = Y.i0[y] * shape[2];
      const y1 = Y.i1[y] * shape[2];
      const wy = Y.w[y];
      for (let x = 0; x < newShape[2]; x++, o++) {
        const x0 = X.i0[x];
        const x1 = X.i1[x];
        const wx = X.w[x];
        const c00 = data[z0 + y0 + x0] * (1 - wx) + data[z0 + y0 + x1] * wx;
        const c01 = data[z0 + y1 + x0] * (1 - wx) + data[z0 + y1 + x1] * wx;
        const c10 = data[z1 + y0 + x0] * (1 - wx) + data[z1 + y0 + x1] * wx;
        const c11 = data[z1 + y1 + x0] * (1 - wx) + data[z1 + y1 + x1] * wx;
        out[o] = (c00 * (1 - wy) + c01 * wy) * (1 - wz) + (c10 * (1 - wy) + c11 * wy) * wz;
      }
    }
  }
  return out;
}

// Sliding-window origins along one axis, as nnU-Net's compute_steps_for_sliding_window.
export function windowStarts(size, patch, step = PLAN.step) {
  if (size <= patch) return [0];
  const count = Math.ceil((size - patch) / (patch * step)) + 1;
  const stride = (size - patch) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(stride * i));
}

export function windows(shape, patch = PLAN.patch) {
  const list = [];
  for (const z of windowStarts(shape[0], patch[0])) {
    for (const y of windowStarts(shape[1], patch[1])) {
      for (const x of windowStarts(shape[2], patch[2])) list.push([z, y, x]);
    }
  }
  return list;
}

// nnU-Net's Gaussian importance map: sigma is an eighth of the patch, peak at the centre.
export function gaussianWeights(patch = PLAN.patch) {
  const axis = (n) => Float32Array.from({ length: n }, (_, i) => Math.exp(-((i - Math.floor(n / 2)) ** 2) / (2 * (n / 8) ** 2)));
  const [gz, gy, gx] = patch.map(axis);
  const out = new Float32Array(product(patch));
  let o = 0;
  for (let z = 0; z < patch[0]; z++) {
    for (let y = 0; y < patch[1]; y++) {
      for (let x = 0; x < patch[2]; x++, o++) out[o] = gz[z] * gy[y] * gx[x];
    }
  }
  return out;
}

function padCentered(image, shape, minimum) {
  const padded = shape.map((n, a) => Math.max(n, minimum[a]));
  const before = padded.map((n, a) => Math.floor((n - shape[a]) / 2));
  if (padded.every((n, a) => n === shape[a])) return { image, shape, before };
  const out = new Float32Array(product(padded));
  for (let z = 0; z < shape[0]; z++) {
    for (let y = 0; y < shape[1]; y++) {
      const src = (z * shape[1] + y) * shape[2];
      const dst = ((z + before[0]) * padded[1] + y + before[1]) * padded[2] + before[2];
      out.set(image.subarray(src, src + shape[2]), dst);
    }
  }
  return { image: out, shape: padded, before };
}

// Runs the network over overlapping patches and returns the lesion probability on the
// brain-cropped input grid. `runPatch(tile, fold)` resolves to logits [2, ...patch]. Folds run
// one after another, so a caller holds one model at a time; their logits are averaged, as in nnU-Net.
export async function predictLesions({ image, shape, runPatch, folds = 1, onPatch = () => {}, signal }) {
  const patch = PLAN.patch;
  const padded = padCentered(image, shape, patch);
  const weights = gaussianWeights(patch);
  const origins = windows(padded.shape);
  const sum = new Float32Array(product(padded.shape));
  const weight = new Float32Array(sum.length);
  const tile = new Float32Array(product(patch));
  const voxels = product(patch);
  const passes = [];
  for (let fold = 0; fold < folds; fold++) {
    for (const origin of origins) passes.push([fold, origin]);
  }
  for (const [n, [fold, [z0, y0, x0]]] of passes.entries()) {
    signal?.throwIfAborted();
    let t = 0;
    for (let z = 0; z < patch[0]; z++) {
      for (let y = 0; y < patch[1]; y++) {
        const start = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
        tile.set(padded.image.subarray(start, start + patch[2]), t);
        t += patch[2];
      }
    }
    const logits = await runPatch(tile, fold);
    signal?.throwIfAborted();
    t = 0;
    for (let z = 0; z < patch[0]; z++) {
      for (let y = 0; y < patch[1]; y++) {
        const row = ((z0 + z) * padded.shape[1] + y0 + y) * padded.shape[2] + x0;
        for (let x = 0; x < patch[2]; x++, t++) {
          // Averaging logits then taking a two-class softmax needs only their difference.
          sum[row + x] += (logits[voxels + t] - logits[t]) * weights[t];
          weight[row + x] += weights[t];
        }
      }
    }
    onPatch(n + 1, passes.length);
  }
  const probability = new Float32Array(product(shape));
  let o = 0;
  for (let z = 0; z < shape[0]; z++) {
    for (let y = 0; y < shape[1]; y++) {
      const row = ((z + padded.before[0]) * padded.shape[1] + y + padded.before[1]) * padded.shape[2] + padded.before[2];
      for (let x = 0; x < shape[2]; x++, o++) probability[o] = 1 / (1 + Math.exp(-sum[row + x] / weight[row + x]));
    }
  }
  return probability;
}

// FLAIR volume + brain mask → lesion probability on the input grid.
export async function segmentFlair({ volume, brainMask, runPatch, folds, onPatch, signal }) {
  const { shape, spacing } = arrayGrid(volume);
  const box = brainBox(brainMask, shape);
  const inside = new Uint8Array(cropVolume(Float32Array.from(brainMask), shape, box));
  const image = normalizeInBrain(cropVolume(volume.data, shape, box), inside);
  const resampledShape = targetShape(box.shape, spacing);
  const resampled = resize(image, box.shape, resampledShape);
  const predicted = await predictLesions({ image: resampled, shape: resampledShape, runPatch, folds, onPatch, signal });
  const cropped = resize(predicted, resampledShape, box.shape);
  const probability = new Float32Array(product(shape));
  let o = 0;
  for (let z = box.lo[0]; z < box.hi[0]; z++) {
    for (let y = box.lo[1]; y < box.hi[1]; y++) {
      probability.set(cropped.subarray(o, o + box.shape[2]), (z * shape[1] + y) * shape[2] + box.lo[2]);
      o += box.shape[2];
    }
  }
  return { probability, windows: windows(resampledShape.map((n, a) => Math.max(n, PLAN.patch[a]))).length, resampledShape };
}

export function threshold(probability, cutoff = 0.5) {
  return Uint8Array.from(probability, (p) => (p > cutoff ? 1 : 0));
}

// 26-connected lesions with voxel counts and centroids (voxel coordinates, x fastest).
export function labelLesions(mask, dims) {
  const [nx, ny, nz] = dims;
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const lesions = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;
    const id = lesions.length + 1;
    let head = 0;
    let tail = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    queue[tail++] = seed;
    labels[seed] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      sx += x;
      sy += y;
      sz += z;
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const j = (zz * ny + yy) * nx + xx;
            if (mask[j] && !labels[j]) {
              labels[j] = id;
              queue[tail++] = j;
            }
          }
        }
      }
    }
    lesions.push({ id, voxels: tail, centroid: [sx / tail, sy / tail, sz / tail] });
  }
  return { labels, lesions };
}

export function voxelVolumeMl(affine) {
  const [a, b, c] = [0, 1, 2].map((col) => [0, 1, 2].map((row) => affine[row][col]));
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  return Math.abs(det) / 1000;
}

export function lesionTable(lesions, affine) {
  const ml = voxelVolumeMl(affine);
  const world = ([x, y, z]) => [0, 1, 2].map((r) => affine[r][0] * x + affine[r][1] * y + affine[r][2] * z + affine[r][3]);
  const rows = lesions
    .map((lesion) => ({ ...lesion, ml: lesion.voxels * ml, world: world(lesion.centroid) }))
    .sort((p, q) => q.voxels - p.voxels);
  const lines = ['lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm'];
  for (const [n, r] of rows.entries()) {
    lines.push([n + 1, r.voxels, r.ml.toFixed(4), ...r.world.map((v) => v.toFixed(1))].join('\t'));
  }
  return { rows, tsv: `${lines.join('\n')}\n`, totalMl: rows.reduce((s, r) => s + r.ml, 0) };
}

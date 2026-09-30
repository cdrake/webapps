import { transformPoint } from './geometry.js';

// Linear-PSF branch of NeSVoR's CUDA operator. Shapes here are x, y, z.
export function createAcquisition({ transforms, volumeShape, sliceShape, resolution, psf, psfShape, volumeMask, sliceMask }) {
  const [width, height, depth] = volumeShape;
  const [sliceWidth, sliceHeight] = sliceShape;
  const pixels = sliceWidth * sliceHeight;
  const count = transforms.length / 12 * pixels;
  const volumeLength = width * height * depth;
  if (!Number.isInteger(count) || count <= 0 || ![...volumeShape, ...sliceShape, ...psfShape].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error('Invalid acquisition dimensions.');
  }
  if (psf.length !== psfShape.reduce((a, b) => a * b, 1) || !(resolution > 0) || !psf.every((v) => Number.isFinite(v) && v >= 0)) {
    throw new Error('Invalid acquisition PSF or resolution.');
  }
  if ((sliceMask && sliceMask.length !== count) || (volumeMask && volumeMask.length !== volumeLength)) throw new Error('Acquisition mask dimensions differ.');

  function coefficients(pixel, visit) {
    const matrix = transforms.subarray(Math.floor(pixel / pixels) * 12, Math.floor(pixel / pixels) * 12 + 12);
    const center = transformPoint(matrix, [(pixel % sliceWidth - (sliceWidth - 1) / 2) * resolution, (Math.floor(pixel / sliceWidth) % sliceHeight - (sliceHeight - 1) / 2) * resolution, 0]);
    let support = 0;
    let index = 0;
    for (let z = -Math.floor(psfShape[2] / 2); z < Math.ceil(psfShape[2] / 2); z++) {
      for (let y = -Math.floor(psfShape[1] / 2); y < Math.ceil(psfShape[1] / 2); y++) {
        for (let x = -Math.floor(psfShape[0] / 2); x < Math.ceil(psfShape[0] / 2); x++) {
          const value = psf[index++];
          if (!value) continue;
          const p = center.map((v, row) => v + matrix[row * 4] * x + matrix[row * 4 + 1] * y + matrix[row * 4 + 2] * z + (volumeShape[row] - 1) / 2);
          if (p.some((v, axis) => v < 0 || v >= volumeShape[axis] - 1)) continue;
          support += value;
          const base = p.map(Math.floor);
          const fraction = p.map((v, axis) => v - base[axis]);
          for (let corner = 0; corner < 8; corner++) {
            const offset = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
            const voxel = base[0] + offset[0] + width * (base[1] + offset[1] + height * (base[2] + offset[2]));
            if (volumeMask && !volumeMask[voxel]) continue;
            const weight = offset.reduce((product, bit, axis) => product * (bit ? fraction[axis] : 1 - fraction[axis]), value);
            if (weight) visit(voxel, weight);
          }
        }
      }
    }
    return support;
  }

  function forward(volume) {
    if (volume.length !== volumeLength) throw new Error('Acquisition volume dimensions differ.');
    const data = new Float64Array(count);
    const weights = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      if (sliceMask && !sliceMask[i]) continue;
      coefficients(i, (voxel, weight) => {
        data[i] += weight * volume[voxel];
        weights[i] += weight;
      });
      if (weights[i] > 0) data[i] /= weights[i];
    }
    return { data, weights };
  }

  function adjoint(slices, { equalize = false } = {}) {
    if (slices.length !== count) throw new Error('Acquisition slice dimensions differ.');
    const data = new Float64Array(volumeLength);
    const weights = new Float64Array(volumeLength);
    for (let i = 0; i < count; i++) {
      if (sliceMask && !sliceMask[i]) continue;
      const support = coefficients(i, () => {});
      // The CUDA adjoint excludes border pixels with less than half PSF support.
      if (support < 0.5) continue;
      coefficients(i, (voxel, weight) => {
        const normalized = weight / support;
        data[voxel] += normalized * slices[i];
        weights[voxel] += normalized;
      });
    }
    if (equalize) {
      for (let i = 0; i < volumeLength; i++) if (weights[i] > 0) data[i] /= weights[i];
    }
    return { data, weights };
  }
  return { forward, adjoint, count, volumeLength };
}

export function reconstructCG(operator, slices, initial, { iterations = 2, tolerance = 0, sliceWeights } = {}) {
  const weighted = (values) => Float64Array.from(values, (v, i) => v * (sliceWeights?.[i] ?? 1));
  const apply = (volume) => operator.adjoint(weighted(operator.forward(volume).data)).data;
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
  const b = operator.adjoint(weighted(slices)).data;
  const x = Float64Array.from(initial);
  const ax = apply(x);
  let r = Float64Array.from(b, (v, i) => v - ax[i]);
  let p = r.slice();
  let rr = dot(r, r);
  for (let iteration = 0; iteration < iterations && rr > tolerance; iteration++) {
    const ap = apply(p);
    const denominator = dot(p, ap);
    if (!(denominator > 0)) throw new Error('SVoRT reconstruction conjugate-gradient system is not positive definite.');
    const alpha = rr / denominator;
    for (let i = 0; i < x.length; i++) x[i] += alpha * p[i];
    r = Float64Array.from(r, (v, i) => v - alpha * ap[i]);
    const next = dot(r, r);
    p = Float64Array.from(r, (v, i) => v + next / rr * p[i]);
    rr = next;
  }
  return x.map((v) => Math.max(0, v));
}

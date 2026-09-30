export function sampleLinear(data, shape, point) {
  const [nx, ny, nz] = shape;
  const base = point.map(Math.floor);
  const fraction = point.map((v, i) => v - base[i]);
  let result = 0;
  for (let corner = 0; corner < 8; corner++) {
    const bits = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const p = bits.map((bit, i) => base[i] + bit);
    if (p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= nx || p[1] >= ny || p[2] >= nz) continue;
    const weight = bits.reduce((v, bit, i) => v * (bit ? fraction[i] : 1 - fraction[i]), 1);
    result += weight * data[p[0] + nx * (p[1] + ny * p[2])];
  }
  return result;
}

export function resample(data, shape, oldResolution, newResolution) {
  const target = shape.map((size, i) => Math.floor(size * oldResolution[i] / newResolution[i]));
  if (target.some((size) => size < 1)) throw new Error('Registration resampling produced an empty dimension.');
  const result = new Float64Array(target.reduce((a, b) => a * b, 1));
  for (let i = 0; i < result.length; i++) {
    const p = [i % target[0], Math.floor(i / target[0]) % target[1], Math.floor(i / (target[0] * target[1]))];
    const source = p.map((v, axis) => (v - (target[axis] - 1) / 2) * newResolution[axis] / oldResolution[axis] + (shape[axis] - 1) / 2);
    result[i] = sampleLinear(data, shape, source);
  }
  return { data: result, shape: target };
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}

export function gaussianBlur(data, shape, sigma, truncated = 4) {
  let result = Float64Array.from(data);
  const strides = [1, shape[0], shape[0] * shape[1]];
  // Upstream separable convolution visits z, y, x.
  for (const axis of [2, 1, 0]) {
    if (!(sigma[axis] > 0)) continue;
    const radius = Math.floor(Math.max(sigma[axis] * truncated, 0.5) + 0.5);
    const scale = 0.70710678 / sigma[axis];
    const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.max(0, 0.5 * (erf(scale * (i - radius + 0.5)) - erf(scale * (i - radius - 0.5)))));
    const next = new Float64Array(data.length);
    for (let i = 0; i < next.length; i++) {
      const coordinate = Math.floor(i / strides[axis]) % shape[axis];
      for (let offset = -radius; offset <= radius; offset++) {
        if (coordinate + offset < 0 || coordinate + offset >= shape[axis]) continue;
        next[i] += result[i + offset * strides[axis]] * kernel[offset + radius];
      }
    }
    result = next;
  }
  return result;
}

export function nccLoss(left, right, mask) {
  let count = mask ? 1e-6 : left.length;
  let sumLeft = 0;
  let sumRight = 0;
  let squareLeft = 0;
  let squareRight = 0;
  let product = 0;
  for (let i = 0; i < left.length; i++) {
    if (mask && !mask[i]) continue;
    if (mask) count++;
    sumLeft += left[i];
    sumRight += right[i];
    squareLeft += left[i] ** 2;
    squareRight += right[i] ** 2;
    product += left[i] * right[i];
  }
  if (!(count > 0)) throw new Error('Registration has no target support.');
  const covariance = product / count - sumLeft * sumRight / count ** 2;
  const varianceLeft = squareLeft / count - (sumLeft / count) ** 2;
  const varianceRight = squareRight / count - (sumRight / count) ** 2;
  return -(covariance ** 2) / (varianceLeft * varianceRight + 1e-6);
}

export function makePSF(ratios) {
  const gaussian = 1 / (2 * Math.sqrt(2 * Math.log(2)));
  const sigma = ratios.map((r, i) => r * gaussian * (i < 2 ? 1.206709128803223 : 1));
  const radius = Math.max(4, ...sigma.map((v) => Math.floor(2 * v + 1)));
  const entries = [];
  const extent = [0, 0, 0];
  for (let z = -radius; z <= radius; z++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        const point = [x, y, z];
        const value = Math.exp(-0.5 * point.reduce((sum, v, i) => sum + (v / sigma[i]) ** 2, 0));
        if (value < 1e-3) continue;
        point.forEach((v, i) => { extent[i] = Math.max(extent[i], Math.abs(v)); });
        entries.push({ point, value });
      }
    }
  }
  const shape = extent.map((v) => 2 * v + 1);
  const data = new Float64Array(shape.reduce((a, b) => a * b, 1));
  const sum = entries.reduce((s, e) => s + e.value, 0);
  for (const { point, value } of entries) {
    const [x, y, z] = point.map((v, i) => v + extent[i]);
    data[x + shape[0] * (y + shape[1] * z)] = value / sum;
  }
  return { psf: data, psfShape: shape };
}

export function percentile(values, q) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  if (!sorted.length) throw new Error('Registration mask has no positive signal.');
  const position = (sorted.length - 1) * q;
  const index = Math.floor(position);
  return sorted[index] + (position - index) * (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]);
}

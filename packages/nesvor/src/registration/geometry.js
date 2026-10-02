export function transformPoint(matrix, point) {
  const p = point.map((value, i) => value + matrix[i * 4 + 3]);
  return [0, 1, 2].map((i) => matrix[i * 4] * p[0] + matrix[i * 4 + 1] * p[1] + matrix[i * 4 + 2] * p[2]);
}

export function matrixToPoints(matrix, width, height, resolution) {
  return [[-(width - 1) * resolution / 2, -(height - 1) * resolution / 2, 0], [0, 0, 0], [(width - 1) * resolution / 2, -(height - 1) * resolution / 2, 0]]
    .flatMap((point) => transformPoint(matrix, point));
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function pointsToMatrix(points) {
  const a = points.slice(0, 3);
  const b = points.slice(3, 6);
  const c = points.slice(6, 9);
  const x = c.map((v, i) => v - a[i]);
  const z = cross(x, b.map((v, i) => v - a[i]));
  const y = cross(z, x);
  const columns = [x, y, z].map((v) => {
    const length = Math.hypot(...v);
    if (!(length > 0)) throw new Error('SVoRT predicted a degenerate slice plane.');
    return v.map((entry) => entry / length);
  });
  const translation = columns.map((v) => v.reduce((sum, entry, i) => sum + entry * b[i], 0));
  return Float64Array.from([0, 1, 2].flatMap((row) => [...columns.map((column) => column[row]), translation[row]]));
}

export function axisAngleToMatrix(pose) {
  const [x, y, z] = pose;
  const square = x * x + y * y + z * z;
  const angle = Math.sqrt(square);
  const a = square < 1e-10 ? 1 - square / 6 : Math.sin(angle) / angle;
  const b = square < 1e-10 ? 0.5 - square / 24 : (1 - Math.cos(angle)) / square;
  const k = [[0, -z, y], [z, 0, -x], [-y, x, 0]];
  return Float64Array.from([0, 1, 2].flatMap((i) => [
    ...[0, 1, 2].map((j) => Number(i === j) + a * k[i][j] + b * k[i].reduce((sum, v, q) => sum + v * k[q][j], 0)),
    pose[i + 3] ?? 0,
  ]));
}

function quaternion(matrix) {
  const m = matrix;
  const trace = m[0] + m[5] + m[10];
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m[9] - m[6]) / s, (m[2] - m[8]) / s, (m[4] - m[1]) / s, s / 4];
  } else {
    const i = [m[0], m[5], m[10]].indexOf(Math.max(m[0], m[5], m[10]));
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    const s = Math.sqrt(1 + m[i * 4 + i] - m[j * 4 + j] - m[k * 4 + k]) * 2;
    q = [0, 0, 0, (m[k * 4 + j] - m[j * 4 + k]) / s];
    q[i] = s / 4;
    q[j] = (m[j * 4 + i] + m[i * 4 + j]) / s;
    q[k] = (m[k * 4 + i] + m[i * 4 + k]) / s;
  }
  const norm = Math.hypot(...q);
  return q.map((v) => v / norm);
}

export function matrixToAxisAngle(matrix) {
  let q = quaternion(matrix);
  if (q[3] < 0) q = q.map((v) => -v);
  const norm = Math.hypot(q[0], q[1], q[2]);
  const factor = norm < 1e-12 ? 2 : 2 * Math.atan2(norm, q[3]) / norm;
  return [...q.slice(0, 3).map((v) => v * factor), matrix[3], matrix[7], matrix[11]];
}

export function inverse(matrix) {
  const result = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) result[i * 4 + j] = matrix[j * 4 + i];
    result[i * 4 + 3] = -[0, 1, 2].reduce((sum, j) => sum + matrix[i * 4 + j] * matrix[j * 4 + 3], 0);
  }
  return result;
}

export function compose(left, right) {
  const result = new Float64Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) result[i * 4 + j] = [0, 1, 2].reduce((sum, k) => sum + left[i * 4 + k] * right[k * 4 + j], 0);
    result[i * 4 + 3] = right[i * 4 + 3] + [0, 1, 2].reduce((sum, j) => sum + right[j * 4 + i] * left[j * 4 + 3], 0);
  }
  return result;
}

export function meanTransform(matrices, { robust = false } = {}) {
  const count = matrices.length / 12;
  if (!count) throw new Error('Cannot average empty transforms.');
  const list = Array.from({ length: count }, (_, i) => matrices.subarray(i * 12, i * 12 + 12));
  const poses = list.map(matrixToAxisAngle);
  const mean = [0, 1, 2, 3, 4, 5].map((i) => poses.reduce((sum, p) => sum + p[i], 0) / count);
  if (!robust) return axisAngleToMatrix(mean);
  const quaternions = list.map(quaternion);
  const q0 = quaternions[0];
  const q = [0, 1, 2, 3].map((i) => quaternions.reduce((sum, value) => sum + value[i] * (value.reduce((dot, v, j) => dot + v * q0[j], 0) < 0 ? -1 : 1), 0) / count);
  const norm = Math.hypot(q[0], q[1], q[2]);
  const factor = norm < 1e-12 ? 2 : 2 * Math.atan2(norm, q[3]) / norm;
  let current = axisAngleToMatrix([...q.slice(0, 3).map((v) => v * factor), 0, 0, 0]);
  let next = current;
  for (let iteration = 0; iteration < 10; iteration++) {
    current = next;
    const differences = list.map((m) => matrixToAxisAngle(compose(m, inverse(current))).slice(0, 3));
    const lengths = differences.map((v) => Math.hypot(...v));
    if (lengths.some((v) => v < 1e-14)) break;
    const denominator = lengths.reduce((sum, v) => sum + 1 / v, 0);
    const delta = [0, 1, 2].map((i) => differences.reduce((sum, v, j) => sum + v[i] / lengths[j], 0) / denominator);
    next = compose(axisAngleToMatrix([...delta, 0, 0, 0]), current);
  }
  for (let i = 0; i < 3; i++) current[i * 4 + 3] = mean[i + 3];
  return current;
}

export function mapTransforms(transforms, fn) {
  return Float64Array.from(Array.from({ length: transforms.length / 12 }, (_, i) => Array.from(fn(transforms.subarray(i * 12, i * 12 + 12), i))).flat());
}

export function stackTransforms(count, gap) {
  return Float64Array.from(Array.from({ length: count }, (_, i) => Array.from(axisAngleToMatrix([0, 0, 0, 0, 0, (i - (count - 1) / 2) * gap]))).flat());
}

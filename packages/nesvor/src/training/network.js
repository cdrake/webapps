import { Parameter } from './autodiff.js';

export function hashIndex(x, y, z, size) {
  return ((x ^ Math.imul(y, 2654435761) ^ Math.imul(z, 805459861)) >>> 0) & (size - 1);
}

// Matches upstream hash_grid_torch.py. CUDA tiny-cuda-nn uses a different
// grid layout; this reference must not be labeled CUDA parity.
export class HashGrid {
  constructor({ levels, features = 2, log2Size = 19, baseResolution, levelScale = 1.3819 }, random = Math.random) {
    this.levels = levels;
    this.features = features;
    this.size = 2 ** log2Size;
    this.resolutions = Array.from({ length: levels }, (_, i) => Math.floor(baseResolution * levelScale ** i));
    const values = new Float32Array(levels * features * this.size);
    for (let i = 0; i < values.length; i++) values[i] = (random() * 2 - 1) * 1e-4;
    this.table = new Parameter(values);
  }
  forward(tape, xyz) {
    const result = [];
    for (let level = 0; level < this.levels; level++) {
      const scaled = xyz.map((x) => tape.scale(x, this.resolutions[level]));
      const floor = scaled.map((x) => Math.floor(x.value));
      const fraction = scaled.map((x, i) => tape.sub(x, tape.constant(floor[i])));
      for (let feature = 0; feature < this.features; feature++) {
        const terms = [];
        for (let corner = 0; corner < 8; corner++) {
          const bits = [corner >> 2, (corner >> 1) & 1, corner & 1];
          const index = hashIndex(...floor.map((x, i) => x + bits[i]), this.size);
          const value = this.table.at(tape, (level * this.size + index) * this.features + feature);
          const weight = fraction.reduce((w, x, i) => tape.mul(w, bits[i] ? x : tape.sub(tape.constant(1), x)), tape.constant(1));
          terms.push(tape.mul(value, weight));
        }
        result.push(tape.sum(terms));
      }
    }
    return result;
  }
}

export class MLP {
  constructor(input, output, width = 64, depth = 1, random = Math.random) {
    const sizes = [input, ...Array(depth).fill(width), output];
    this.layers = sizes.slice(1).map((size, i) => {
      const bound = 1 / Math.sqrt(sizes[i]);
      return {
        input: sizes[i], output: size,
        weight: new Parameter(Array.from({ length: sizes[i] * size }, () => (random() * 2 - 1) * bound)),
        bias: new Parameter(Array.from({ length: size }, () => (random() * 2 - 1) * bound)),
      };
    });
  }
  get parameters() { return this.layers.flatMap((l) => [l.weight, l.bias]); }
  forward(tape, input) {
    return this.layers.reduce((values, layer, index) => Array.from({ length: layer.output }, (_, o) => {
      let value = layer.bias.at(tape, o);
      for (let i = 0; i < layer.input; i++) value = tape.add(value, tape.mul(values[i], layer.weight.at(tape, o * layer.input + i)));
      return index < this.layers.length - 1 ? tape.relu(value) : value;
    }), input);
  }
}

export function rotation(tape, axis) {
  const theta2 = tape.sum(axis.map((x) => tape.square(x)));
  let a, b;
  if (theta2.value < 1e-8) {
    a = tape.add(tape.sub(tape.constant(1), tape.scale(theta2, 1 / 6)), tape.scale(tape.square(theta2), 1 / 120));
    b = tape.add(tape.sub(tape.constant(0.5), tape.scale(theta2, 1 / 24)), tape.scale(tape.square(theta2), 1 / 720));
  } else {
    const theta = tape.sqrt(theta2);
    a = tape.div(tape.sin(theta), theta);
    b = tape.div(tape.sub(tape.constant(1), tape.cos(theta)), theta2);
  }
  const zero = tape.constant(0);
  const [x, y, z] = axis;
  const k = [[zero, tape.scale(z, -1), y], [z, zero, tape.scale(x, -1)], [tape.scale(y, -1), x, zero]];
  return k.map((row, i) => row.map((v, j) => tape.add(tape.add(tape.constant(i === j ? 1 : 0), tape.mul(a, v)), tape.mul(b, tape.sum(k[i].map((entry, q) => tape.mul(entry, k[q][j])))))));
}

export function transform(tape, pose, point) {
  const r = rotation(tape, pose.slice(0, 3));
  const translated = point.map((p, i) => tape.add(p, pose[i + 3]));
  return r.map((row) => tape.sum(row.map((v, i) => tape.mul(v, translated[i]))));
}

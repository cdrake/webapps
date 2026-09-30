import { Parameter } from '../training/autodiff.js';
import { hashIndex } from '../training/network.js';

export const DEFORMATION_DEFAULTS = Object.freeze({ features: 4, embeddingFeatures: 8, coarsest: 32, finest: 8, levelScale: 1.3819, log2Size: 19, width: 64, spatialScaling: 30 });

export function createDeformationModel({ boundingBox, slices, ...options }, random = Math.random) {
  const config = { ...DEFORMATION_DEFAULTS, ...options };
  if (!Number.isInteger(slices) || slices < 1 || !boundingBox?.flat().every(Number.isFinite)) throw new Error('Invalid deformation model geometry');
  const extent = boundingBox[1].map((x, i) => x - boundingBox[0][i]);
  if (extent.some(x => x <= 0)) throw new Error('Deformation bounds must have positive extent');
  const base = Math.ceil(Math.max(...extent) * config.spatialScaling / config.coarsest);
  const levels = Math.ceil(Math.log(Math.max(...extent) * config.spatialScaling / config.finest / base) / Math.log(config.levelScale) + 1);
  const size = 2 ** config.log2Size;
  if (levels < 1 || !Number.isInteger(config.features) || config.features < 1 || !Number.isInteger(config.width) || config.width < 1) throw new Error('Invalid deformation architecture');
  const uniform = length => {
    const values = new Float32Array(length);
    for (let i = 0; i < length; i++) values[i] = (random() * 2 - 1) * 1e-4;
    return new Parameter(values);
  };
  const table = uniform(levels * size * config.features);
  const embedding = new Parameter(Array.from({ length: slices * config.embeddingFeatures }, () => Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) * Math.cos(2 * Math.PI * random())));
  const sizes = [levels * config.features + config.embeddingFeatures, config.width, config.width, 3];
  let activationSize = sizes[0];
  const layers = sizes.slice(1).map((output, i) => {
    const layer = { input: sizes[i], output, weight: uniform(sizes[i] * output), bias: uniform(output), inputOffset: i ? activationSize - sizes[i] : 0, outputOffset: activationSize, hidden: i < 2 };
    activationSize += output;
    return layer;
  });
  const parameters = [table, ...layers.flatMap(layer => [layer.weight, layer.bias]), embedding];
  let count = 0;
  const offsets = parameters.map(parameter => { const offset = count; count += parameter.values.length; return offset; });
  layers.forEach((layer, i) => { layer.weightOffset = offsets[1 + i * 2]; layer.biasOffset = offsets[2 + i * 2]; });
  return { config, boundingBox, extent, slices, levels, size, resolutions: Array.from({ length: levels }, (_, i) => Math.floor(base * config.levelScale ** i)), table, embedding, embeddingOffset: offsets.at(-1), layers, parameters, offsets, count, activationSize };
}

function encodingCorners(model, xyz, level) {
  const resolution = model.resolutions[level];
  const scaled = xyz.map((x, a) => (x - model.boundingBox[0][a]) / model.extent[a] * resolution);
  const floor = scaled.map(Math.floor);
  const fraction = scaled.map((x, a) => x - floor[a]);
  const smooth = fraction.map(t => t * t * (3 - 2 * t));
  const derivative = fraction.map((t, a) => 6 * t * (1 - t) * resolution / model.extent[a]);
  return Array.from({ length: 8 }, (_, corner) => {
    const bits = [corner >> 2, (corner >> 1) & 1, corner & 1];
    const factors = bits.map((bit, a) => bit ? smooth[a] : 1 - smooth[a]);
    return { index: hashIndex(...floor.map((x, a) => x + bits[a]), model.size), jet: [factors[0] * factors[1] * factors[2], ...bits.map((bit, a) => (bit ? 1 : -1) * derivative[a] * factors[(a + 1) % 3] * factors[(a + 2) % 3])] };
  });
}

// A jet carries a value and its three exact spatial derivatives. Reverse mode
// through these jets differentiates the Jacobian penalty without finite differences.
export function evaluateDeformation(model, xyz, slice, { xyzGradient = [0, 0, 0], regularizationWeight = 0, backward = false } = {}) {
  const jets = new Float64Array(model.activationSize * 4);
  const corners = model.resolutions.map((_, level) => encodingCorners(model, xyz, level));
  for (let l = 0; l < model.levels; l++) {
    for (let f = 0; f < model.config.features; f++) {
      for (const corner of corners[l]) {
        const parameter = model.table.values[(l * model.size + corner.index) * model.config.features + f];
        for (let a = 0; a < 4; a++) jets[(l * model.config.features + f) * 4 + a] += parameter * corner.jet[a];
      }
    }
  }
  const encoded = model.levels * model.config.features;
  for (let f = 0; f < model.config.embeddingFeatures; f++) jets[(encoded + f) * 4] = model.embedding.values[slice * model.config.embeddingFeatures + f];
  for (const layer of model.layers) {
    for (let o = 0; o < layer.output; o++) {
      const offset = (layer.outputOffset + o) * 4;
      jets[offset] = layer.bias.values[o];
      for (let i = 0; i < layer.input; i++) {
        const weight = layer.weight.values[o * layer.input + i];
        for (let a = 0; a < 4; a++) jets[offset + a] += weight * jets[(layer.inputOffset + i) * 4 + a];
      }
      if (layer.hidden) {
        jets[offset] = Math.tanh(jets[offset]);
        for (let a = 1; a < 4; a++) jets[offset + a] *= 1 - jets[offset] ** 2;
      }
    }
  }
  const outputOffset = model.layers.at(-1).outputOffset;
  const output = xyz.map((x, o) => x + model.extent[o] * jets[(outputOffset + o) * 4]);
  const jacobian = Array.from({ length: 3 }, (_, o) => Array.from({ length: 3 }, (_, a) => (o === a ? 1 : 0) + model.extent[o] * jets[(outputOffset + o) * 4 + a + 1]));
  const residual = jacobian.map((row, o) => jacobian.map((other, p) => row.reduce((sum, x, a) => sum + x * other[a], o === p ? -1 : 0)));
  let regularization = residual.flat().reduce((sum, x) => sum + x * x, 0);
  if (!Number.isFinite(regularization)) regularization = 0;
  const inputGradient = [...xyzGradient];
  if (backward) {
    for (const regularizer of [false, true]) {
      if (regularizer && !regularizationWeight) continue;
      const adjoints = new Float64Array(jets.length);
      for (let o = 0; o < 3; o++) {
        const offset = (outputOffset + o) * 4;
        if (!regularizer) adjoints[offset] = xyzGradient[o] * model.extent[o];
        else for (let a = 0; a < 3; a++) adjoints[offset + a + 1] = 4 * regularizationWeight * model.extent[o] * residual[o].reduce((sum, r, p) => sum + r * jacobian[p][a], 0);
      }
      for (let l = model.layers.length - 1; l >= 0; l--) {
        const layer = model.layers[l];
        for (let o = 0; o < layer.output; o++) {
          const offset = (layer.outputOffset + o) * 4;
          const g = Array.from(adjoints.subarray(offset, offset + 4));
          if (layer.hidden) {
            const value = jets[offset];
            g[0] = g[0] * (1 - value * value) - 2 * value * g.slice(1).reduce((sum, x, a) => sum + x * jets[offset + a + 1], 0);
            for (let a = 1; a < 4; a++) g[a] *= 1 - value * value;
          }
          layer.bias.gradient[o] += g[0];
          for (let i = 0; i < layer.input; i++) {
            const input = (layer.inputOffset + i) * 4;
            const wi = o * layer.input + i;
            for (let a = 0; a < 4; a++) {
              layer.weight.gradient[wi] += g[a] * jets[input + a];
              adjoints[input + a] += g[a] * layer.weight.values[wi];
            }
          }
        }
      }
      if (!regularizer) {
        for (let f = 0; f < model.config.embeddingFeatures; f++) model.embedding.gradient[slice * model.config.embeddingFeatures + f] += adjoints[(encoded + f) * 4];
        for (let i = 0; i < encoded; i++) for (let a = 0; a < 3; a++) inputGradient[a] += adjoints[i * 4] * jets[i * 4 + a + 1];
      }
      for (let l = 0; l < model.levels; l++) for (let f = 0; f < model.config.features; f++) {
        const offset = (l * model.config.features + f) * 4;
        for (const corner of corners[l]) for (let a = 0; a < 4; a++) model.table.gradient[(l * model.size + corner.index) * model.config.features + f] += adjoints[offset + a] * corner.jet[a];
      }
    }
  }
  return { xyz: output, jacobian, regularization, xyzGradient: inputGradient };
}

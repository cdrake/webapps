import { Tape, Parameter, adamW } from './autodiff.js';
import { HashGrid, MLP, rotation, transform } from './network.js';
export { Tape, Parameter, adamW } from './autodiff.js';
export { HashGrid, MLP, hashIndex, rotation, transform } from './network.js';

export const DEFAULTS = Object.freeze({ features: 2, log2Size: 19, levelScale: 1.3819, coarsest: 16, finest: 0.5, width: 64, depth: 1, latent: 15, sliceFeatures: 16, spatialScaling: 30, delta: 0.2, weightImage: 1, weightTransformation: 0.1, weightDeform: 0.1, learningRate: 0.005, iterations: 6000, samples: 256, batchSize: 4096 });

export class ReferenceNeSVoR {
  constructor({ boundingBox, poses, mean, ...options }, random = Math.random) {
    this.config = { ...DEFAULTS, ...options };
    this.boundingBox = boundingBox;
    this.initialPoses = Float32Array.from(poses);
    this.poses = new Parameter(poses);
    this.slices = poses.length / 6;
    const c = this.config;
    const extent = Math.max(...boundingBox[1].map((x, i) => x - boundingBox[0][i])) * c.spatialScaling;
    const baseResolution = Math.ceil(extent / c.coarsest);
    const levels = Math.ceil(Math.log(extent / c.finest / baseResolution) / Math.log(c.levelScale) + 1);
    this.grid = new HashGrid({ ...c, levels, baseResolution }, random);
    this.density = new MLP(levels * c.features, 1 + c.latent, c.width, c.depth, random);
    this.uncertainty = new MLP(c.sliceFeatures + c.latent, 1, c.width, c.depth, random);
    this.embedding = new Parameter(Array.from({ length: this.slices * c.sliceFeatures }, () => gaussian(random)));
    this.scale = new Parameter(new Float32Array(this.slices));
    this.variance = new Parameter(new Float32Array(this.slices));
    this.delta = c.delta * mean;
  }
  get parameters() { return [this.grid.table, ...this.density.parameters, ...this.uncertainty.parameters, this.embedding, this.scale, this.variance, this.poses]; }
  evaluate(tape, xyz, slice) {
    const normalized = xyz.map((x, i) => tape.scale(tape.sub(x, tape.constant(this.boundingBox[0][i])), 1 / (this.boundingBox[1][i] - this.boundingBox[0][i])));
    const z = this.density.forward(tape, this.grid.forward(tape, normalized));
    const density = tape.softplus(z[0]);
    if (slice === undefined) return { density };
    const embedding = Array.from({ length: this.config.sliceFeatures }, (_, i) => this.embedding.at(tape, slice * this.config.sliceFeatures + i));
    return { density, variance: tape.exp(this.uncertainty.forward(tape, [...embedding, ...z.slice(1)])[0]) };
  }
  objective(batch) {
    const t = new Tape();
    const c = this.config;
    const poses = Array.from({ length: this.slices }, (_, s) => Array.from({ length: 6 }, (_, i) => this.poses.at(t, s * 6 + i)));
    const max = Math.max(...this.scale.values);
    const exp = Array.from(this.scale.values, (_, i) => t.exp(t.sub(this.scale.at(t, i), t.constant(max))));
    const denominator = t.sum(exp);
    const scales = exp.map((x) => t.scale(t.div(x, denominator), this.slices));
    const data = [], logVariance = [], image = [];
    for (const observation of batch) {
      const { slice, xyz, target, offsets } = observation;
      const points = offsets.map((offset) => transform(t, poses[slice], xyz.map((x, i) => t.constant(x + offset[i]))));
      const outputs = points.map((point) => this.evaluate(t, point, slice));
      const prediction = t.mul(scales[slice], t.mean(outputs.map((o) => o.density)));
      // Upstream explicitly detaches c in the pixel-variance branch.
      const variance = t.add(t.square(t.scale(t.mean(outputs.map((o) => o.variance)), scales[slice].value)), t.exp(this.variance.at(t, slice)));
      data.push(t.div(t.square(t.sub(prediction, t.constant(target))), t.scale(variance, 2)));
      logVariance.push(t.scale(t.log(variance), 0.5));
      for (let j = 0; j < outputs.length; j++) {
        const k = outputs.length - j - 1;
        const distance = t.add(t.scale(t.sum(points[j].map((x, i) => t.square(t.sub(x, points[k][i])))), c.spatialScaling ** 2), t.constant(1e-6));
        const grad2 = t.div(t.square(t.sub(outputs[j].density, outputs[k].density)), distance);
        image.push(t.scale(t.sub(t.sqrt(t.add(t.constant(1), t.scale(grad2, 1 / this.delta ** 2))), t.constant(1)), this.delta));
      }
    }
    const transReg = transformationLoss(this, t, poses);
    const terms = { MSE: t.mean(data), logVar: t.mean(logVariance), imageReg: t.mean(image), transReg };
    const total = t.sum([terms.MSE, terms.logVar, t.scale(terms.imageReg, c.weightImage), t.scale(terms.transReg, c.weightTransformation)]);
    return { tape: t, total, terms };
  }
  step(batch, step, learningRate = this.config.learningRate) {
    this.parameters.forEach((p) => p.zeroGrad());
    const { tape, total, terms } = this.objective(batch);
    tape.backward(total);
    adamW(this.parameters, step, { learningRate });
    return Object.fromEntries(Object.entries(terms).map(([key, value]) => [key, value.value]));
  }
  sample(xyz) {
    const tape = new Tape();
    return this.evaluate(tape, xyz.map((x) => tape.constant(x))).density.value;
  }
}

export function gaussian(random = Math.random) {
  return Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) * Math.cos(2 * Math.PI * random());
}

// Iterates explicit, externally prepared observations. This reference is meant
// for fixture-sized runs; it does not claim clinical preset throughput.
export async function fitReference(model, observations, { iterations = model.config.iterations, batchSize = model.config.batchSize, samples = model.config.samples, random = Math.random, signal, onProgress = () => {} } = {}) {
  if (!observations.length) throw new Error('No masked observations');
  const indices = observations.map((_, i) => i);
  let cursor = indices.length;
  for (let step = 1; step <= iterations; step++) {
    signal?.throwIfAborted();
    if (cursor + batchSize > indices.length) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      cursor = 0;
    }
    const batch = indices.slice(cursor, cursor + batchSize).map((index) => {
      const observation = observations[index];
      return { ...observation, offsets: Array.from({ length: samples }, () => observation.sigma.map((sigma) => gaussian(random) * sigma)) };
    });
    cursor += batchSize;
    const decays = [0.5, 0.75, 0.9].filter((fraction) => step > Math.floor(fraction * iterations)).length;
    const losses = model.step(batch, step, model.config.learningRate * 0.33 ** decays);
    onProgress({ step, iterations, losses });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return model;
}

export function transformationLoss(model, t, poses) {
  const c = model.config;
    const poseLosses = poses.map((pose, s) => {
      const initial = Array.from(model.initialPoses.slice(s * 6, s * 6 + 6), (x) => t.constant(x));
      const r = rotation(t, pose.slice(0, 3));
      const ri = rotation(t, initial.slice(0, 3));
      const relative = r.map((_, i) => r.map((__, j) => t.sum(r.map((row, k) => t.mul(row[i], ri[k][j])))));
      const cosine = t.scale(t.sub(t.sum(relative.map((row, i) => row[i])), t.constant(1)), 0.5);
      const value = Math.max(-1, Math.min(1, cosine.value));
      const angle = Math.acos(value);
      const angle2 = t.value(angle * angle, [cosine], [value > 1 - 1e-7 ? -2 : -2 * angle / Math.sqrt(1 - value * value)]);
      const translation = pose.slice(3).map((v, i) => t.sub(v, t.sum(relative[i].map((x, j) => t.mul(x, initial[j + 3])))));
      return t.add(t.scale(angle2, 1 / 3), t.scale(t.mean(translation.map((x) => t.square(x))), 1e-3 * c.spatialScaling ** 2));
    });
  return t.mean(poseLosses);
}

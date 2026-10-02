// Small ordered reverse-mode reference for numerical fixtures, not a GPU runtime.
export class Tape {
  constructor() { this.nodes = []; }
  value(value, parents = [], partials = [], sink) {
    const node = { value, gradient: 0, parents, partials, sink };
    this.nodes.push(node);
    return node;
  }
  constant(value) { return this.value(value); }
  add(a, b) { return this.value(a.value + b.value, [a, b], [1, 1]); }
  sub(a, b) { return this.value(a.value - b.value, [a, b], [1, -1]); }
  mul(a, b) { return this.value(a.value * b.value, [a, b], [b.value, a.value]); }
  div(a, b) { return this.value(a.value / b.value, [a, b], [1 / b.value, -a.value / b.value ** 2]); }
  exp(a) { const y = Math.exp(a.value); return this.value(y, [a], [y]); }
  log(a) { return this.value(Math.log(a.value), [a], [1 / a.value]); }
  sqrt(a) { const y = Math.sqrt(a.value); return this.value(y, [a], [0.5 / y]); }
  sin(a) { return this.value(Math.sin(a.value), [a], [Math.cos(a.value)]); }
  cos(a) { return this.value(Math.cos(a.value), [a], [-Math.sin(a.value)]); }
  relu(a) { return this.value(Math.max(0, a.value), [a], [a.value > 0 ? 1 : 0]); }
  softplus(a) {
    const y = Math.max(a.value, 0) + Math.log1p(Math.exp(-Math.abs(a.value)));
    return this.value(y, [a], [1 / (1 + Math.exp(-a.value))]);
  }
  scale(a, b) { return this.mul(a, this.constant(b)); }
  square(a) { return this.mul(a, a); }
  sum(values) { return values.reduce((a, b) => this.add(a, b), this.constant(0)); }
  mean(values) { return this.scale(this.sum(values), 1 / values.length); }
  backward(loss) {
    loss.gradient = 1;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      for (let j = 0; j < n.parents.length; j++) n.parents[j].gradient += n.gradient * n.partials[j];
      if (n.sink) n.sink(n.gradient);
    }
  }
}

export class Parameter {
  constructor(values) {
    this.values = Float32Array.from(values);
    this._gradient = null;
    this._first = null;
    this._second = null;
  }
  get gradient() { return this._gradient ??= new Float64Array(this.values.length); }
  set gradient(value) { this._gradient = value; }
  get first() { return this._first ??= new Float32Array(this.values.length); }
  set first(value) { this._first = value; }
  get second() { return this._second ??= new Float32Array(this.values.length); }
  set second(value) { this._second = value; }
  at(tape, index) {
    return tape.value(this.values[index], [], [], (g) => { this.gradient[index] += g; });
  }
  zeroGrad() { this._gradient?.fill(0); }
}

export function adamW(parameters, step, { learningRate = 0.005, beta1 = 0.9, beta2 = 0.99, epsilon = 1e-15, weightDecay = 0.01 } = {}) {
  for (const p of parameters) {
    for (let i = 0; i < p.values.length; i++) {
      const g = p.gradient[i];
      if (!Number.isFinite(g)) throw new Error('Non-finite NeSVoR gradient');
      p.first[i] = beta1 * p.first[i] + (1 - beta1) * g;
      p.second[i] = beta2 * p.second[i] + (1 - beta2) * g * g;
      const m = p.first[i] / (1 - beta1 ** step);
      const v = p.second[i] / (1 - beta2 ** step);
      p.values[i] = p.values[i] * (1 - learningRate * weightDecay) - learningRate * m / (Math.sqrt(v) + epsilon);
    }
  }
}

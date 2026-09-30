export const FIELD_SHADER = /* wgsl */ `
struct Config {
  count: u32, activation_size: u32, levels: u32, features: u32,
  hash_size: u32, density_layers: u32, layer_count: u32, embedding_size: u32,
  embedding_offset: u32, density_output: u32, sigma_input: u32, sigma_output: u32,
  minimum: vec4<f32>, inverse_extent: vec4<f32>,
};
struct Layer {
  inputs: u32, outputs: u32, weights: u32, biases: u32,
  input_offset: u32, output_offset: u32, relu: u32, unused: u32,
};
struct Query { xyz: vec3<f32>, slice: u32 };
@group(0) @binding(0) var<storage, read> parameters: array<f32>;
@group(0) @binding(1) var<storage, read_write> gradients: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> layers: array<Layer>;
@group(0) @binding(3) var<storage, read> resolutions: array<u32>;
@group(0) @binding(4) var<storage, read> queries: array<Query>;
struct QueryIO { output: vec2<f32>, cotangent: vec2<f32>, xyz_gradient: vec4<f32> };
@group(0) @binding(5) var<storage, read_write> scratch: array<f32>;
@group(0) @binding(6) var<storage, read_write> query_io: array<QueryIO>;
@group(0) @binding(7) var<storage, read_write> failure: atomic<u32>;
@group(0) @binding(8) var<uniform> config: Config;
fn finite(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }
fn add_gradient(index: u32, contribution: f32) {
  if (!finite(contribution)) { atomicStore(&failure, 1u); return; }
  if (contribution == 0.0) { return; }
  var old = atomicLoad(&gradients[index]);
  // A bounded contention failure invalidates the entire accumulated gradient.
  for (var attempt = 0u; attempt < 65536u; attempt++) {
    let sum = bitcast<f32>(old) + contribution;
    if (!finite(sum)) { atomicStore(&failure, 1u); return; }
    let result = atomicCompareExchangeWeak(&gradients[index], old, bitcast<u32>(sum));
    if (result.exchanged) { return; }
    old = result.old_value;
  }
  atomicStore(&failure, 2u);
}
fn hash_index(p: vec3<i32>) -> u32 {
  let q = vec3<u32>(p);
  return (q.x ^ (q.y * 2654435761u) ^ (q.z * 805459861u)) & (config.hash_size - 1u);
}
fn corner_bits(corner: u32) -> vec3<u32> {
  return vec3<u32>(corner >> 2u, (corner >> 1u) & 1u, corner & 1u);
}
fn corner_weights(fraction: vec3<f32>, bits: vec3<u32>) -> vec3<f32> {
  return select(vec3<f32>(1.0) - fraction, fraction, bits == vec3<u32>(1u));
}
fn softplus(x: f32) -> f32 { return max(x, 0.0) + log(1.0 + exp(-abs(x))); }
fn sigmoid(x: f32) -> f32 {
  if (x >= 0.0) { return 1.0 / (1.0 + exp(-x)); }
  let e = exp(x);
  return e / (1.0 + e);
}
fn forward_layer(query: u32, index: u32) {
  let layer = layers[index];
  let base = query * config.activation_size;
  for (var o = 0u; o < layer.outputs; o++) {
    var value = parameters[layer.biases + o];
    for (var i = 0u; i < layer.inputs; i++) {
      value += parameters[layer.weights + o * layer.inputs + i] * scratch[base + layer.input_offset + i];
    }
    if (layer.relu != 0u) { value = max(value, 0.0); }
    if (!finite(value)) { atomicStore(&failure, 1u); }
    scratch[base + layer.output_offset + o] = value;
  }
}
@compute @workgroup_size(64)
fn forward(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let q = invocation.x;
  if (q >= config.count) { return; }
  let base = q * config.activation_size;
  let xyz = (queries[q].xyz - config.minimum.xyz) * config.inverse_extent.xyz;
  for (var level = 0u; level < config.levels; level++) {
    let point = xyz * f32(resolutions[level]);
    let lower = vec3<i32>(floor(point));
    let fraction = point - floor(point);
    for (var feature = 0u; feature < config.features; feature++) {
      var value = 0.0;
      for (var corner = 0u; corner < 8u; corner++) {
        let bits = corner_bits(corner);
        let weights = corner_weights(fraction, bits);
        let index = (level * config.hash_size + hash_index(lower + vec3<i32>(bits))) * config.features + feature;
        value += parameters[index] * weights.x * weights.y * weights.z;
      }
      scratch[base + level * config.features + feature] = value;
    }
  }
  for (var layer = 0u; layer < config.density_layers; layer++) { forward_layer(q, layer); }
  for (var i = 0u; i < config.embedding_size; i++) {
    scratch[base + config.sigma_input + i] = parameters[config.embedding_offset + queries[q].slice * config.embedding_size + i];
  }
  let latent = layers[config.density_layers - 1u].outputs - 1u;
  for (var i = 0u; i < latent; i++) {
    scratch[base + config.sigma_input + config.embedding_size + i] = scratch[base + config.density_output + 1u + i];
  }
  for (var layer = config.density_layers; layer < config.layer_count; layer++) { forward_layer(q, layer); }
  let density = softplus(scratch[base + config.density_output]);
  let variance = exp(scratch[base + config.sigma_output]);
  if (!finite(density) || !finite(variance)) { atomicStore(&failure, 1u); }
  query_io[q].output = vec2<f32>(density, variance);
}
fn backward_layer(query: u32, index: u32) {
  let layer = layers[index];
  let base = query * config.activation_size;
  for (var o = 0u; o < layer.outputs; o++) {
    var delta = scratch[config.count * config.activation_size + base + layer.output_offset + o];
    if (layer.relu != 0u && scratch[base + layer.output_offset + o] <= 0.0) { delta = 0.0; }
    scratch[config.count * config.activation_size + base + layer.output_offset + o] = delta;
    for (var i = 0u; i < layer.inputs; i++) {
      let parameter = layer.weights + o * layer.inputs + i;
      scratch[config.count * config.activation_size + base + layer.input_offset + i] += delta * parameters[parameter];
    }
  }
}
// Each lane owns one dense parameter, so dense gradients use an ordered
// reduction instead of competing floating-point compare/exchanges.
@compute @workgroup_size(64)
fn reduce_dense(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let parameter = config.levels * config.hash_size * config.features + invocation.x;
  if (parameter >= config.embedding_offset) { return; }
  var sum = 0.0;
  for (var l = 0u; l < config.layer_count; l++) {
    let layer = layers[l];
    if (parameter >= layer.weights && parameter < layer.weights + layer.inputs * layer.outputs) {
      let local = parameter - layer.weights;
      let output = local / layer.inputs;
      let input = local % layer.inputs;
      for (var q = 0u; q < config.count; q++) {
        let base = q * config.activation_size;
        sum += scratch[base + layer.input_offset + input]
          * scratch[config.count * config.activation_size + base + layer.output_offset + output];
      }
      break;
    }
    if (parameter >= layer.biases && parameter < layer.biases + layer.outputs) {
      let output = parameter - layer.biases;
      for (var q = 0u; q < config.count; q++) {
        sum += scratch[config.count * config.activation_size + q * config.activation_size + layer.output_offset + output];
      }
      break;
    }
  }
  let value = bitcast<f32>(atomicLoad(&gradients[parameter])) + sum;
  if (!finite(value)) { atomicStore(&failure, 1u); return; }
  atomicStore(&gradients[parameter], bitcast<u32>(value));
}
@compute @workgroup_size(64)
fn backward(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let q = invocation.x;
  if (q >= config.count) { return; }
  let base = q * config.activation_size;
  for (var i = 0u; i < config.activation_size; i++) { scratch[config.count * config.activation_size + base + i] = 0.0; }
  scratch[config.count * config.activation_size + base + config.sigma_output] = query_io[q].cotangent.y * query_io[q].output.y;
  for (var layer = config.layer_count; layer > config.density_layers; layer--) { backward_layer(q, layer - 1u); }
  for (var i = 0u; i < config.embedding_size; i++) {
    add_gradient(config.embedding_offset + queries[q].slice * config.embedding_size + i, scratch[config.count * config.activation_size + base + config.sigma_input + i]);
  }
  let latent = layers[config.density_layers - 1u].outputs - 1u;
  for (var i = 0u; i < latent; i++) {
    scratch[config.count * config.activation_size + base + config.density_output + 1u + i] = scratch[config.count * config.activation_size + base + config.sigma_input + config.embedding_size + i];
  }
  scratch[config.count * config.activation_size + base + config.density_output] = query_io[q].cotangent.x * sigmoid(scratch[base + config.density_output]);
  for (var layer = config.density_layers; layer > 0u; layer--) { backward_layer(q, layer - 1u); }
  let xyz = (queries[q].xyz - config.minimum.xyz) * config.inverse_extent.xyz;
  var gradient = vec3<f32>(0.0);
  for (var level = 0u; level < config.levels; level++) {
    let point = xyz * f32(resolutions[level]);
    let lower = vec3<i32>(floor(point));
    let fraction = point - floor(point);
    for (var feature = 0u; feature < config.features; feature++) {
      let delta = scratch[config.count * config.activation_size + base + level * config.features + feature];
      for (var corner = 0u; corner < 8u; corner++) {
        let bits = corner_bits(corner);
        let weights = corner_weights(fraction, bits);
        let index = (level * config.hash_size + hash_index(lower + vec3<i32>(bits))) * config.features + feature;
        add_gradient(index, delta * weights.x * weights.y * weights.z);
        let signs = select(vec3<f32>(-1.0), vec3<f32>(1.0), bits == vec3<u32>(1u));
        gradient += delta * parameters[index] * signs * vec3<f32>(weights.y * weights.z, weights.x * weights.z, weights.x * weights.y) * f32(resolutions[level]);
      }
    }
  }
  gradient *= config.inverse_extent.xyz;
  if (!finite(gradient.x) || !finite(gradient.y) || !finite(gradient.z)) { atomicStore(&failure, 1u); }
  query_io[q].xyz_gradient = vec4<f32>(gradient, 0.0);
}
`;

export const OPTIMIZER_SHADER = /* wgsl */ `
struct Config { count: u32, learning_rate: f32, correction1: f32, correction2: f32 };
@group(0) @binding(0) var<storage, read_write> parameters: array<f32>;
@group(0) @binding(1) var<storage, read_write> gradients: array<f32>;
@group(0) @binding(2) var<storage, read_write> first: array<f32>;
@group(0) @binding(3) var<storage, read_write> second: array<f32>;
@group(0) @binding(4) var<uniform> config: Config;
@group(0) @binding(5) var<storage, read_write> failure: atomic<u32>;
fn finite(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }
@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let i = id.x + id.y * groups.x * 64u;
  if (i >= config.count) { return; }
  let g = gradients[i];
  let m = 0.9 * first[i] + 0.1 * g;
  let v = 0.99 * second[i] + 0.01 * g * g;
  let value = parameters[i] * (1.0 - config.learning_rate * 0.01)
    - config.learning_rate * (m / config.correction1) / (sqrt(v / config.correction2) + 1e-15);
  if (!finite(m) || !finite(v) || !finite(value)) { atomicStore(&failure, 1u); return; }
  first[i] = m;
  second[i] = v;
  parameters[i] = value;
}
`;

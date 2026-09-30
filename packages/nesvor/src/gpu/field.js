import { FIELD_SHADER, OPTIMIZER_SHADER } from './shaders.js';

function finiteArray(array, name) {
  if (!array.every(Number.isFinite)) throw new Error(`${name} contains non-finite values`);
}

export function fieldLayout(model) {
  const parameters = [model.grid.table, ...model.density.parameters, ...model.uncertainty.parameters, model.embedding];
  const offsets = new Map();
  let count = 0;
  for (const parameter of parameters) {
    offsets.set(parameter, count);
    count += parameter.values.length;
  }
  const values = new Float32Array(count);
  for (const parameter of parameters) values.set(parameter.values, offsets.get(parameter));
  const layers = [];
  let activationSize = model.grid.levels * model.grid.features;
  let inputOffset = 0;
  const addNetwork = network => {
    for (let i = 0; i < network.layers.length; i++) {
      const layer = network.layers[i];
      layers.push([layer.input, layer.output, offsets.get(layer.weight), offsets.get(layer.bias), inputOffset, activationSize, i < network.layers.length - 1 ? 1 : 0, 0]);
      inputOffset = activationSize;
      activationSize += layer.output;
    }
  };
  addNetwork(model.density);
  const densityOutput = inputOffset;
  const sigmaInput = activationSize;
  inputOffset = sigmaInput;
  activationSize += model.config.sliceFeatures + model.config.latent;
  addNetwork(model.uncertainty);
  const sigmaOutput = inputOffset;
  return { parameters, offsets: parameters.map(parameter => offsets.get(parameter)), values, layers: Uint32Array.from(layers.flat()), activationSize, densityOutput, sigmaInput, sigmaOutput, embeddingOffset: offsets.get(model.embedding) };
}

export async function createGPUField(device, model, { microbatchSize = 256 } = {}) {
  if (!Number.isInteger(microbatchSize) || microbatchSize < 1) throw new Error('microbatchSize must be a positive integer');
  const layout = fieldLayout(model);
  finiteArray(layout.values, 'Parameters');
  const resources = [];
  let disposed = false;
  let busy = false;
  let validGradients = false;
  let gradientFailure = false;
  let lost = null;
  let poisoned = null;
  device.lost.then(info => { lost = new Error(`NeSVoR GPU device lost: ${info.message}`); });
  const buffer = (size, usage, data) => {
    if (size > device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && size > device.limits.maxStorageBufferBindingSize)) throw new Error(`NeSVoR buffer of ${size} bytes exceeds device binding limits`);
    const result = device.createBuffer({ size: Math.max(4, size), usage });
    resources.push(result);
    if (data) device.queue.writeBuffer(result, 0, data);
    return result;
  };
  const compile = async code => {
    const module = device.createShaderModule({ code });
    const errors = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(errors.map(error => `${error.lineNum}:${error.linePos} ${error.message}`).join('\n'));
    return module;
  };
  let parameterBuffer, gradientBuffer, first, second, layerBuffer, resolutions, queries, scratch, io, failure, config, optimizerConfig, transfer;
  let forwardPipeline, backwardPipeline, reductionPipeline, optimizerPipeline, fieldBindGroup, optimizerBindGroup;
  const scoped = async (fn) => {
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    let result;
    let failure;
    try {
      result = await fn();
    } catch (error) {
      failure = error;
    }
    const errors = [];
    for (const type of ['validation', 'out-of-memory']) {
      try {
        const error = await device.popErrorScope();
        if (error) errors.push(new Error(`NeSVoR WebGPU ${type}: ${error.message}`));
      } catch (error) {
        errors.push(new Error(`NeSVoR WebGPU error scope failed: ${error.message}`));
      }
    }
    if (lost || errors.length) {
      poisoned = lost ?? errors[0];
      validGradients = false;
      gradientFailure = true;
      throw poisoned;
    }
    if (failure) throw failure;
    return result;
  };
  try {
    await scoped(async () => {
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      parameterBuffer = buffer(layout.values.byteLength, storage, layout.values);
      gradientBuffer = buffer(layout.values.byteLength, storage);
      first = buffer(layout.values.byteLength, storage);
      second = buffer(layout.values.byteLength, storage);
      layerBuffer = buffer(layout.layers.byteLength, storage, layout.layers);
      resolutions = buffer(model.grid.levels * 4, storage, Uint32Array.from(model.grid.resolutions));
      queries = buffer(microbatchSize * 16, storage);
      scratch = buffer(microbatchSize * layout.activationSize * 8, storage);
      io = buffer(microbatchSize * 32, storage);
      failure = buffer(4, storage);
      config = buffer(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      optimizerConfig = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      transfer = buffer(microbatchSize * 32 + 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      const module = await compile(FIELD_SHADER);
      const bindings = [parameterBuffer, gradientBuffer, layerBuffer, resolutions, queries, scratch, io, failure, config];
      const bindingLayout = device.createBindGroupLayout({ entries: bindings.map((_, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 8 ? 'uniform' : [0, 2, 3, 4].includes(binding) ? 'read-only-storage' : 'storage' } })) });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindingLayout] });
      forwardPipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'forward' } });
      backwardPipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'backward' } });
      reductionPipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint: 'reduce_dense' } });
      fieldBindGroup = device.createBindGroup({ layout: bindingLayout, entries: bindings.map((entry, binding) => ({ binding, resource: { buffer: entry } })) });
      const optimizerModule = await compile(OPTIMIZER_SHADER);
      optimizerPipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: optimizerModule, entryPoint: 'step' } });
      optimizerBindGroup = device.createBindGroup({ layout: optimizerPipeline.getBindGroupLayout(0), entries: [parameterBuffer, gradientBuffer, first, second, optimizerConfig, failure].map((entry, binding) => ({ binding, resource: { buffer: entry } })) });
    });
  } catch (error) {
    resources.forEach(resource => resource.destroy());
    throw error;
  }
  const check = () => {
    if (disposed) throw new Error('NeSVoR GPU field has been disposed');
    if (lost) throw lost;
    if (poisoned) throw poisoned;
  };
  const exclusive = async fn => {
    check();
    if (busy) throw new Error('Concurrent use of a NeSVoR GPU field is not supported');
    busy = true;
    try {
      const result = await scoped(fn);
      check();
      return result;
    } finally {
      busy = false;
    }
  };
  const readBuffer = async (source, bytes) => {
    const destination = bytes <= transfer.size ? transfer : device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, destination, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await destination.mapAsync(GPUMapMode.READ, 0, bytes);
      const result = destination.getMappedRange(0, bytes).slice(0);
      destination.unmap();
      return result;
    } finally { if (destination !== transfer) destination.destroy(); }
  };
  const split = values => layout.parameters.map((parameter, i) => values.slice(layout.offsets[i], layout.offsets[i] + parameter.values.length));
  const compute = async (input, backward, { accumulate = false, readGradients = true, signal } = {}) => {
    const { xyz, sliceIndices, densityGradient, varianceGradient } = input;
    if (!(xyz instanceof Float32Array) || !(sliceIndices instanceof Uint32Array) || xyz.length !== sliceIndices.length * 3 || !sliceIndices.length) throw new Error('Expected xyz Float32Array[3*N] and sliceIndices Uint32Array[N]');
    finiteArray(xyz, 'Coordinates');
    if (sliceIndices.some(index => index >= model.slices)) throw new Error('Slice index exceeds the prepared model');
    if (backward) {
      if (!(densityGradient instanceof Float32Array) || !(varianceGradient instanceof Float32Array) || densityGradient.length !== sliceIndices.length || varianceGradient.length !== sliceIndices.length) throw new Error('Expected density and variance cotangents for every query');
      finiteArray(densityGradient, 'Density cotangents');
      finiteArray(varianceGradient, 'Variance cotangents');
      if (accumulate && gradientFailure) throw new Error('Previous gradient accumulation failed; reset with accumulate:false');
      if (!accumulate) {
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(gradientBuffer);
        device.queue.submit([encoder.finish()]);
        gradientFailure = false;
      }
      validGradients = false;
    }
    const density = new Float32Array(sliceIndices.length);
    const variance = new Float32Array(sliceIndices.length);
    const xyzGradient = backward ? new Float32Array(xyz.length) : undefined;
    try {
      for (let start = 0; start < sliceIndices.length; start += microbatchSize) {
        signal?.throwIfAborted();
        check();
        const count = Math.min(microbatchSize, sliceIndices.length - start);
        const queryBytes = new ArrayBuffer(count * 16);
        const floats = new Float32Array(queryBytes);
        const integers = new Uint32Array(queryBytes);
        const ioData = new Float32Array(count * 8);
        for (let i = 0; i < count; i++) {
          floats.set(xyz.subarray((start + i) * 3, (start + i + 1) * 3), i * 4);
          integers[i * 4 + 3] = sliceIndices[start + i];
          if (backward) ioData.set([densityGradient[start + i], varianceGradient[start + i]], i * 8 + 2);
        }
        const settings = new ArrayBuffer(80);
        new Uint32Array(settings).set([count, layout.activationSize, model.grid.levels, model.grid.features, model.grid.size, model.density.layers.length, layout.layers.length / 8, model.config.sliceFeatures, layout.embeddingOffset, layout.densityOutput, layout.sigmaInput, layout.sigmaOutput]);
        const settingsFloats = new Float32Array(settings);
        settingsFloats.set(model.boundingBox[0], 12);
        settingsFloats.set(model.boundingBox[1].map((max, i) => 1 / (max - model.boundingBox[0][i])), 16);
        device.queue.writeBuffer(config, 0, settings);
        device.queue.writeBuffer(queries, 0, queryBytes);
        device.queue.writeBuffer(io, 0, ioData);
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(failure);
        const pass = encoder.beginComputePass();
        pass.setBindGroup(0, fieldBindGroup);
        pass.setPipeline(forwardPipeline);
        pass.dispatchWorkgroups(Math.ceil(count / 64));
        if (backward) {
          pass.setPipeline(backwardPipeline);
          pass.dispatchWorkgroups(Math.ceil(count / 64));
          pass.setPipeline(reductionPipeline);
          pass.dispatchWorkgroups(Math.ceil((layout.embeddingOffset - model.grid.table.values.length) / 64));
        }
        pass.end();
        encoder.copyBufferToBuffer(io, 0, transfer, 0, count * 32);
        encoder.copyBufferToBuffer(failure, 0, transfer, count * 32, 4);
        device.queue.submit([encoder.finish()]);
        await transfer.mapAsync(GPUMapMode.READ, 0, count * 32 + 4);
        const data = transfer.getMappedRange(0, count * 32 + 4).slice(0);
        transfer.unmap();
        const failureCode = new Uint32Array(data)[count * 8];
        if (failureCode) throw new Error(failureCode === 2 ? 'NeSVoR GPU gradient accumulation contention limit exceeded' : 'NeSVoR GPU produced a non-finite value');
        const result = new Float32Array(data);
        for (let i = 0; i < count; i++) {
          density[start + i] = result[i * 8];
          variance[start + i] = result[i * 8 + 1];
          if (backward) xyzGradient.set(result.subarray(i * 8 + 4, i * 8 + 7), (start + i) * 3);
        }
      }
      if (backward) validGradients = true;
    } catch (error) {
      if (backward) { gradientFailure = true; validGradients = false; }
      throw error;
    }
    const gradients = backward && readGradients ? split(new Float32Array(await readBuffer(gradientBuffer, layout.values.byteLength))) : undefined;
    return { density, variance, xyzGradient, gradients };
  };
  return {
    parameterIndices: layout.parameters.map((_, i) => i),
    plannedBytes: resources.reduce((sum, resource) => sum + resource.size, 0),
    forward: (input, options) => exclusive(() => compute(input, false, options)),
    backward: (input, options) => exclusive(async () => {
      try { return await compute(input, true, options); }
      catch (error) { gradientFailure = true; validGradients = false; throw error; }
    }),
    readParameters: () => exclusive(async () => split(new Float32Array(await readBuffer(parameterBuffer, layout.values.byteLength)))),
    readGradients: () => exclusive(async () => split(new Float32Array(await readBuffer(gradientBuffer, layout.values.byteLength)))),
    step: (step, learningRate = 0.005) => exclusive(async () => {
      if (!validGradients || gradientFailure) throw new Error('A complete valid gradient is required before an optimizer step');
      if (!Number.isInteger(step) || step < 1 || !Number.isFinite(learningRate) || learningRate <= 0) throw new Error('Invalid AdamW step or learning rate');
      const bytes = new ArrayBuffer(16);
      new Uint32Array(bytes)[0] = layout.values.length;
      new Float32Array(bytes).set([learningRate, 1 - 0.9 ** step, 1 - 0.99 ** step], 1);
      device.queue.writeBuffer(optimizerConfig, 0, bytes);
      const encoder = device.createCommandEncoder();
      encoder.clearBuffer(failure);
      const pass = encoder.beginComputePass();
      pass.setPipeline(optimizerPipeline);
      pass.setBindGroup(0, optimizerBindGroup);
      const groups = Math.ceil(layout.values.length / 64);
      const width = Math.min(groups, device.limits.maxComputeWorkgroupsPerDimension);
      pass.dispatchWorkgroups(width, Math.ceil(groups / width));
      pass.end();
      device.queue.submit([encoder.finish()]);
      validGradients = false;
      const failed = new Uint32Array(await readBuffer(failure, 4))[0];
      if (failed) {
        poisoned = new Error('NeSVoR AdamW produced non-finite state; discard this field');
        throw poisoned;
      }
    }),
    dispose: () => { disposed = true; resources.forEach(resource => resource.destroy()); },
  };
}

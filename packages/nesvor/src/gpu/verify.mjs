#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (relative(root, path).startsWith('..')) throw new Error('Invalid path');
    response.setHeader('Content-Type', 'text/javascript');
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>NeSVoR GPU verification</title>');
    } else response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report = await page.evaluate(async () => {
    const { ReferenceNeSVoR, Tape, adamW } = await import('/packages/nesvor/src/training/index.js');
    const { createGPUField } = await import('/packages/nesvor/src/gpu/field.js');
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    let seed = 42;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
    const model = new ReferenceNeSVoR({ boundingBox: [[-1, -2, -3], [1, 2, 3]], poses: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], mean: 1, log2Size: 2, width: 5, depth: 2, latent: 3, sliceFeatures: 3, coarsest: 64, finest: 32 }, random);
    // Nontrivial coordinate derivatives; initialization alone makes them tiny.
    model.grid.table.values.forEach((_, i, values) => { values[i] = (random() - 0.5) * 0.3; });
    const count = 67;
    const xyz = Float32Array.from({ length: count * 3 }, (_, i) => (random() - 0.5) * (i % 3 + 1));
    const sliceIndices = Uint32Array.from({ length: count }, (_, i) => i % 2);
    const densityGradient = Float32Array.from({ length: count }, () => (random() - 0.5) / count);
    const varianceGradient = Float32Array.from({ length: count }, () => (random() - 0.5) / count);
    const expected = { density: [], variance: [], xyzGradient: [] };
    model.parameters.forEach(parameter => parameter.zeroGrad());
    for (let i = 0; i < count; i++) {
      const tape = new Tape();
      const coordinates = Array.from(xyz.subarray(i * 3, i * 3 + 3), value => tape.constant(value));
      const result = model.evaluate(tape, coordinates, sliceIndices[i]);
      expected.density.push(result.density.value);
      expected.variance.push(result.variance.value);
      tape.backward(tape.add(tape.scale(result.density, densityGradient[i]), tape.scale(result.variance, varianceGradient[i])));
      expected.xyzGradient.push(...coordinates.map(coordinate => coordinate.gradient));
    }
    const field = await createGPUField(device, model, { microbatchSize: 17 });
    const input = { xyz, sliceIndices, densityGradient, varianceGradient };
    const actual = await field.backward(input);
    const compare = (name, actual, expected, tolerance) => {
      let maximum = 0;
      for (let i = 0; i < actual.length; i++) {
        if (!Number.isFinite(actual[i])) throw new Error(`${name}[${i}] is not finite`);
        const error = Math.abs(actual[i] - expected[i]);
        maximum = Math.max(maximum, error);
        if (error > tolerance * Math.max(1, Math.abs(expected[i]))) throw new Error(`${name}[${i}]: ${actual[i]} != ${expected[i]}, error ${error}`);
      }
      return maximum;
    };
    const maxima = {};
    maxima.density = compare('density', actual.density, expected.density, 2e-6);
    maxima.variance = compare('variance', actual.variance, expected.variance, 2e-6);
    maxima.xyzGradient = compare('xyzGradient', actual.xyzGradient, expected.xyzGradient, 2e-6);
    maxima.parameterGradient = 0;
    for (let i = 0; i < actual.gradients.length; i++) maxima.parameterGradient = Math.max(maxima.parameterGradient, compare(`parameterGradient${i}`, actual.gradients[i], model.parameters[i].gradient, 3e-6));
    await field.step(1, 0.005);
    adamW(model.parameters.slice(0, actual.gradients.length), 1);
    const updated = await field.readParameters();
    maxima.adam = 0;
    for (let i = 0; i < updated.length; i++) maxima.adam = Math.max(maxima.adam, compare(`adam${i}`, updated[i], model.parameters[i].values, 3e-5));
    field.dispose();
    // Same explicit draws, different microbatch partition and two accumulations.
    const a = await createGPUField(device, model, { microbatchSize: 1 });
    const b = await createGPUField(device, model, { microbatchSize: 64 });
    const all = await a.backward(input);
    const first = { xyz: xyz.slice(0, 33 * 3), sliceIndices: sliceIndices.slice(0, 33), densityGradient: densityGradient.slice(0, 33), varianceGradient: varianceGradient.slice(0, 33) };
    const last = { xyz: xyz.slice(33 * 3), sliceIndices: sliceIndices.slice(33), densityGradient: densityGradient.slice(33), varianceGradient: varianceGradient.slice(33) };
    await b.backward(first, { readGradients: false });
    const accumulated = await b.backward(last, { accumulate: true });
    maxima.accumulation = 0;
    for (let i = 0; i < all.gradients.length; i++) maxima.accumulation = Math.max(maxima.accumulation, compare(`accumulation${i}`, accumulated.gradients[i], all.gradients[i], 3e-6));
    let rejected = false;
    try { await b.backward({ ...input, densityGradient: Float32Array.from({ length: count }, () => NaN) }); } catch { rejected = true; }
    if (!rejected) throw new Error('Non-finite cotangent was accepted');
    a.dispose();
    b.dispose();
    const { gpuTrainingStep } = await import('/packages/nesvor/src/training/gpu-fit.js');
    maxima.fullLoss = 0;
    maxima.fullParameters = 0;
    for (const observationsPerChunk of [1, 2]) {
      const config = { boundingBox: [[-1, -2, -3], [1, 2, 3]], poses: [0.03, -0.04, 0.02, 0.01, 0.02, -0.03, -0.02, 0.03, 0.01, -0.01, 0.03, 0.02], mean: 1, log2Size: 3, width: 5, depth: 2, latent: 3, sliceFeatures: 3, coarsest: 64, finest: 32 };
      const cpuModel = new ReferenceNeSVoR(config, random);
      const gpuModel = new ReferenceNeSVoR(config, random);
      cpuModel.parameters.forEach((parameter, i) => gpuModel.parameters[i].values.set(parameter.values));
      const trainingField = await createGPUField(device, gpuModel, { microbatchSize: 5 });
      const trainingBatch = Array.from({ length: 4 }, (_, i) => ({ slice: i % 2, xyz: [0.13 + i * 0.01, -0.2, 0.1], target: 0.7 + i * 0.17, offsets: [[-0.03, 0.01, -0.02], [0.01, -0.02, 0.04], [0.02, -0.01, 0.03]] }));
      for (let step = 1; step <= 2; step++) {
        const expectedLoss = cpuModel.step(trainingBatch, step);
        const gpuLoss = await gpuTrainingStep(gpuModel, trainingField, trainingBatch, step, { observationsPerChunk });
        for (const name of Object.keys(expectedLoss)) maxima.fullLoss = Math.max(maxima.fullLoss, compare(`loss ${name}`, [gpuLoss[name]], [expectedLoss[name]], 3e-6));
        const resident = await trainingField.readParameters();
        const allParameters = [...resident, gpuModel.scale.values, gpuModel.variance.values, gpuModel.poses.values];
        for (let i = 0; i < allParameters.length; i++) maxima.fullParameters = Math.max(maxima.fullParameters, compare(`full step ${step} parameter ${i}`, allParameters[i], cpuModel.parameters[i].values, 5e-5));
      }
      trainingField.dispose();
    }
    const upstream = await (await fetch('/packages/nesvor/test/upstream-training.json')).json();
    const upstreamModel = new ReferenceNeSVoR(upstream.config, random);
    upstreamModel.parameters.forEach((parameter, i) => parameter.values.set(upstream.parameters[i]));
    const upstreamField = await createGPUField(device, upstreamModel, { microbatchSize: 5 });
    const upstreamLoss = await gpuTrainingStep(upstreamModel, upstreamField, upstream.batch, 1, { observationsPerChunk: 2 });
    maxima.upstreamLoss = 0;
    for (const name of Object.keys(upstreamLoss)) maxima.upstreamLoss = Math.max(maxima.upstreamLoss, compare(`upstream loss ${name}`, [upstreamLoss[name]], [upstream.losses[name]], 2e-6));
    const upstreamUpdated = [...await upstreamField.readParameters(), upstreamModel.scale.values, upstreamModel.variance.values, upstreamModel.poses.values];
    maxima.upstreamParameters = 0;
    upstreamUpdated.forEach((values, i) => { maxima.upstreamParameters = Math.max(maxima.upstreamParameters, compare(`upstream parameter ${i}`, values, upstream.updated[i], 2e-5)); });
    upstreamField.dispose();
    const exceptional = await createGPUField(device, model, { microbatchSize: 2 });
    const single = { xyz: xyz.slice(0, 3), sliceIndices: sliceIndices.slice(0, 1), densityGradient: new Float32Array([1e30]), varianceGradient: new Float32Array([0]) };
    await exceptional.backward(single, { readGradients: false });
    let overflowRejected = false;
    try { await exceptional.step(1); } catch (error) { overflowRejected = /non-finite/.test(error.message); }
    if (!overflowRejected) throw new Error('Optimizer overflow was not rejected');
    let poisonedRejected = false;
    try { await exceptional.forward(single); } catch { poisonedRejected = true; }
    if (!poisonedRejected) throw new Error('Optimizer corruption did not invalidate the field');
    exceptional.dispose();
    const cancellable = await createGPUField(device, model, { microbatchSize: 2 });
    const controller = new AbortController();
    controller.abort();
    let cancellationRejected = false;
    try { await cancellable.backward(input, { signal: controller.signal }); } catch (error) { cancellationRejected = error.name === 'AbortError'; }
    if (!cancellationRejected) throw new Error('Cancelled gradient calculation was accepted');
    let cancelledStepRejected = false;
    try { await cancellable.step(1); } catch { cancelledStepRejected = true; }
    if (!cancelledStepRejected) throw new Error('Optimizer accepted incomplete cancelled gradients');
    cancellable.dispose();
    const trackDevice = ({ failAllocation = false, validationFailure = false } = {}) => {
      const allocated = [];
      const destroyed = new Set();
      const scopes = [];
      let injectOom = false;
      const wrapped = new Proxy(device, {
        get(target, key) {
          if (key === 'createBuffer') return (descriptor) => {
            if (failAllocation && allocated.length === 4) throw new Error('Injected allocation failure');
            const resource = target.createBuffer(descriptor);
            const destroy = resource.destroy.bind(resource);
            resource.destroy = () => { destroyed.add(resource); destroy(); };
            allocated.push(resource);
            if (validationFailure && allocated.length === 1) target.queue.writeBuffer(resource, 2, new Uint8Array(4));
            return resource;
          };
          if (key === 'pushErrorScope') return (type) => { scopes.push(type); target.pushErrorScope(type); };
          if (key === 'popErrorScope') return async () => {
            const type = scopes.pop();
            const error = await target.popErrorScope();
            return injectOom && type === 'out-of-memory' ? new GPUOutOfMemoryError('Injected scoped OOM') : error;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { wrapped, allocated, destroyed, scopes, injectOom: () => { injectOom = true; } };
    };
    for (const options of [{ failAllocation: true }, { validationFailure: true }]) {
      const tracked = trackDevice(options);
      let rejected = false;
      try { await createGPUField(tracked.wrapped, model, { microbatchSize: 1 }); }
      catch (error) { rejected = /Injected allocation failure|WebGPU validation/.test(error.message); }
      if (!rejected || !tracked.allocated.length || tracked.destroyed.size !== tracked.allocated.length || tracked.scopes.length) throw new Error('Failed field initialization leaked GPU resources or scopes');
    }
    const oomDevice = trackDevice();
    const oomField = await createGPUField(oomDevice.wrapped, model, { microbatchSize: 1 });
    oomDevice.injectOom();
    let oomRejected = false;
    try { await oomField.forward({ xyz: xyz.slice(0, 3), sliceIndices: sliceIndices.slice(0, 1) }); }
    catch (error) { oomRejected = /out-of-memory/.test(error.message); }
    if (!oomRejected) throw new Error('A scoped OOM published a forward result');
    let oomPoisonedRejected = false;
    try { await oomField.readParameters(); } catch (error) { oomPoisonedRejected = /out-of-memory/.test(error.message); }
    if (!oomPoisonedRejected) throw new Error('GPU field continued after OOM');
    oomField.dispose();
    if (oomDevice.destroyed.size !== oomDevice.allocated.length || oomDevice.scopes.length) throw new Error('OOM cleanup leaked resources or scopes');
    const lostAdapter = await navigator.gpu.requestAdapter();
    const lostDevice = await lostAdapter.requestDevice();
    const lostField = await createGPUField(lostDevice, model, { microbatchSize: 1 });
    lostDevice.destroy();
    await lostDevice.lost;
    let deviceLossRejected = false;
    try { await lostField.forward({ xyz: xyz.slice(0, 3), sliceIndices: sliceIndices.slice(0, 1) }); }
    catch (error) { deviceLossRejected = /device lost/.test(error.message); }
    if (!deviceLossRejected) throw new Error('Lost GPU device published a forward result');
    lostField.dispose();
    if (errors.length) throw new Error(errors.join('\n'));
    const report = { adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description, device: adapter.info?.device }, browser: navigator.userAgent, queries: count, hashEntriesPerLevel: model.grid.size, microbatches: [1, 17, 64], optimizerOverflowRejected: true, cancellationRejected: true, initializationCleanup: true, scopedValidationRejected: true, scopedOomRejected: true, deviceLossRejected: true, maxima, passed: true, cudaParity: false };
    device.destroy();
    return report;
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = JSON.parse(await readFile(process.argv[2] ?? new URL('./fixtures/upstream-training.json', import.meta.url), 'utf8'));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (relative(root, path).startsWith('..')) throw new Error('Invalid path');
    response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript');
    response.end(request.url === '/' ? '<!doctype html><title>Deformation training verification</title>' : await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report = await page.evaluate(async fixture => {
    const { ReferenceNeSVoR } = await import('/packages/nesvor/src/training/index.js');
    const { createGPUField } = await import('/packages/nesvor/src/gpu/field.js');
    const { gpuTrainingStep } = await import('/packages/nesvor/src/training/gpu-fit.js');
    const { createDeformationModel } = await import('/packages/nesvor/src/deformation/model.js');
    const { createGPUDeformation } = await import('/packages/nesvor/src/deformation/gpu.js');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    const compare = (name, actual, expected, tolerance) => {
      if (actual.length !== expected.length) throw new Error(`${name}: length mismatch`);
      let maximum = 0;
      for (let i = 0; i < actual.length; i++) {
        const error = Math.abs(actual[i] - expected[i]);
        if (!Number.isFinite(actual[i]) || error > tolerance * Math.max(1, Math.abs(expected[i]))) throw new Error(`${name}[${i}]: ${actual[i]} != ${expected[i]}`);
        maximum = Math.max(maximum, error);
      }
      return maximum;
    };
    const maxima = { losses: 0, fieldGradients: 0, deformationGradients: 0, fieldUpdated: 0, deformationUpdated: 0 };
    for (const observationsPerChunk of [1, 2, 3]) {
      const model = new ReferenceNeSVoR(fixture.config);
      model.parameters.forEach((p, i) => p.values.set(fixture.parameters[i]));
      const deformationModel = createDeformationModel(fixture.deformationConfig);
      deformationModel.parameters.forEach((p, i) => p.values.set(fixture.deformationParameters[i]));
      const field = await createGPUField(device, model, { microbatchSize: 3 });
      const deformation = await createGPUDeformation(device, deformationModel, { microbatchSize: 3 });
      let fieldGradients;
      let deformationGradients;
      const inspectField = { ...field, backward: async (input, options) => {
        const result = await field.backward(input, { ...options, readGradients: true });
        fieldGradients = result.gradients;
        return result;
      } };
      const inspectDeformation = { ...deformation, backward: async (input, options) => {
        const result = await deformation.backward(input, { ...options, readGradients: true });
        deformationGradients = result.gradients;
        return result;
      } };
      const losses = await gpuTrainingStep(model, inspectField, fixture.batch, 1, { observationsPerChunk, deformation: inspectDeformation });
      if (!('deformReg' in losses)) throw new Error('Training step did not execute deformation regularization');
      for (const [name, value] of Object.entries(losses)) maxima.losses = Math.max(maxima.losses, compare(name, [value], [fixture.losses[name]], 5e-6));
      const gradients = [...fieldGradients, model.scale.gradient, model.variance.gradient, model.poses.gradient];
      gradients.forEach((g, i) => { maxima.fieldGradients = Math.max(maxima.fieldGradients, compare(`field gradient ${i}`, g, fixture.gradients[i], 2e-5)); });
      deformationGradients.forEach((g, i) => { maxima.deformationGradients = Math.max(maxima.deformationGradients, compare(`deformation gradient ${i}`, g, fixture.deformationGradients[i], 2e-5)); });
      const updated = [...await field.readParameters(), model.scale.values, model.variance.values, model.poses.values];
      updated.forEach((p, i) => { maxima.fieldUpdated = Math.max(maxima.fieldUpdated, compare(`field updated ${i}`, p, fixture.updated[i], 3e-5)); });
      (await deformation.readParameters()).forEach((p, i) => { maxima.deformationUpdated = Math.max(maxima.deformationUpdated, compare(`deformation updated ${i}`, p, fixture.deformationUpdated[i], 3e-5)); });
      field.dispose();
      deformation.dispose();
    }
    device.destroy();
    if (errors.length) throw new Error(errors.join('\n'));
    return { passed: true, sourceCommit: fixture.sourceCommit, oracle: fixture.oracle, observationsPerChunk: [1, 2, 3], psfSamples: 5, regularizerSamples: 4, maxima };
  }, fixture);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

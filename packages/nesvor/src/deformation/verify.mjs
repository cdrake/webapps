import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeformationModel, evaluateDeformation } from './model.js';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const oracle = JSON.parse(await readFile(process.argv[3], 'utf8'));
const model = createDeformationModel({ boundingBox: input.boundingBox, slices: input.slices, ...input.config });
model.parameters.forEach((p, i) => p.values.set(input.parameters[i]));
const expected = { xyz: [], xyzGradient: [], regularization: [] };
for (let i = 0; i < input.sliceIndices.length; i++) {
  const result = evaluateDeformation(model, input.xyz.slice(i * 3, i * 3 + 3), input.sliceIndices[i], { xyzGradient: input.xyzGradient.slice(i * 3, i * 3 + 3), regularizationWeight: input.regularizationWeights[i], backward: true });
  expected.xyz.push(...result.xyz);
  expected.xyzGradient.push(...result.xyzGradient);
  expected.regularization.push(result.regularization);
}
expected.gradients = model.parameters.map(p => Array.from(p.gradient));
function compare(name, actual, wanted, tolerance = 3e-6) {
  let max = 0;
  if (actual.length !== wanted.length) throw new Error(`${name} length mismatch`);
  for (let i = 0; i < actual.length; i++) {
    const error = Math.abs(actual[i] - wanted[i]);
    if (!Number.isFinite(actual[i]) || error > tolerance * Math.max(1, Math.abs(wanted[i]))) throw new Error(`${name}[${i}]: ${actual[i]} != ${wanted[i]}`);
    max = Math.max(max, error);
  }
  return max;
}
const report = { cpu: {}, gpu: {} };
for (const key of ['xyz', 'xyzGradient', 'regularization']) report.cpu[key] = compare(key, expected[key], oracle[key]);
report.cpu.gradients = Math.max(...expected.gradients.map((g, i) => compare(`gradient${i}`, g, oracle.gradients[i])));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (relative(root, path).startsWith('..')) throw new Error('Invalid path');
    response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'text/javascript');
    response.end(request.url === '/' ? '<!doctype html><title>Deformation verification</title>' : await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const actual = await page.evaluate(async input => {
    const { createDeformationModel } = await import('/packages/nesvor/src/deformation/model.js');
    const { createGPUDeformation } = await import('/packages/nesvor/src/deformation/gpu.js');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const model = createDeformationModel({ boundingBox: input.boundingBox, slices: input.slices, ...input.config });
    model.parameters.forEach((p, i) => p.values.set(input.parameters[i]));
    const field = await createGPUDeformation(device, model, { microbatchSize: 7 });
    const queries = { xyz: Float32Array.from(input.xyz), sliceIndices: Uint32Array.from(input.sliceIndices), xyzGradient: Float32Array.from(input.xyzGradient), regularizationWeights: Float32Array.from(input.regularizationWeights) };
    const result = await field.backward(queries, { readGradients: true });
    const output = Object.fromEntries(Object.entries(result).map(([key, values]) => [key, key === 'gradients' ? values.map(v => Array.from(v)) : Array.from(values)]));
    const cut = 13;
    const segment = (start, end) => ({ xyz: queries.xyz.slice(start * 3, end * 3), sliceIndices: queries.sliceIndices.slice(start, end), xyzGradient: queries.xyzGradient.slice(start * 3, end * 3), regularizationWeights: queries.regularizationWeights.slice(start, end) });
    await field.backward(segment(0, cut));
    const accumulated = await field.backward(segment(cut, input.sliceIndices.length), { accumulate: true, readGradients: true });
    for (let p = 0; p < result.gradients.length; p++) for (let i = 0; i < result.gradients[p].length; i++) if (Math.abs(result.gradients[p][i] - accumulated.gradients[p][i]) > 1e-6) throw new Error('Deformation accumulation changes effective batch gradients');
    await field.step(1, 0.005);
    output.parameters = (await field.readParameters()).map(p => Array.from(p));
    const regularizerOnly = await field.backward({ ...queries, xyzGradient: new Float32Array(queries.xyz.length) }, { readGradients: true });
    if (regularizerOnly.xyzGradient.some(x => x !== 0) || regularizerOnly.gradients.at(-1).some(x => x !== 0)) throw new Error('Regularizer must detach coordinates and embeddings');
    field.dispose();
    const defaultModel = createDeformationModel({ boundingBox: input.boundingBox, slices: input.slices });
    const defaultField = await createGPUDeformation(device, defaultModel, { microbatchSize: 2 });
    await defaultField.backward({ xyz: queries.xyz.slice(0, 6), sliceIndices: queries.sliceIndices.slice(0, 2), xyzGradient: queries.xyzGradient.slice(0, 6), regularizationWeights: new Float32Array([0.5, 0.5]) });
    if (Math.ceil(defaultModel.count / 64) <= device.limits.maxComputeWorkgroupsPerDimension) throw new Error('Default optimizer test must span multiple dispatch rows');
    await defaultField.step(1, 0.005);
    const defaultUpdated = await defaultField.readParameters();
    if (defaultUpdated.some(p => !p.every(Number.isFinite))) throw new Error('Default optimizer produced non-finite parameters');
    const untouched = defaultModel.table.values.length - 1;
    if (Math.abs(defaultUpdated[0][untouched] - Math.fround(defaultModel.table.values[untouched] * (1 - 0.005 * 0.01))) > 1e-11) throw new Error('Default optimizer did not visit final hash-table entry');
    defaultField.dispose();
    device.destroy();
    return output;
  }, input);
  for (const key of ['xyz', 'xyzGradient', 'regularization']) report.gpu[key] = compare(key, actual[key], oracle[key], 1e-5);
  report.gpu.gradients = Math.max(...actual.gradients.map((g, i) => compare(`gradient${i}`, g, oracle.gradients[i], 1e-5)));
  report.gpu.optimizer = Math.max(...actual.parameters.map((p, i) => compare(`parameter${i}`, p, input.parameters[i].map((x, j) => x * (1 - 0.005 * 0.01) - 0.005 * actual.gradients[i][j] / (Math.abs(actual.gradients[i][j]) + 1e-15)), 2e-6)));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

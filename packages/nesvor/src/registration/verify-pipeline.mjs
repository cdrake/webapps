import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeStacks } from '../input.js';

const modelDirectory = process.argv[2];
const stackDirectory = process.argv[3];
if (!modelDirectory || !stackDirectory) throw new Error('Usage: node verify-pipeline.mjs MODEL_DIRECTORY STACK_DIRECTORY');
const source = fileURLToPath(new URL('../../../../', import.meta.url));
const runtimeDirectory = fileURLToPath(new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url));
const examples = JSON.parse(await readFile(new URL('../../../../apps/nesvor/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const stacks = [];
const fixture = [];
for (let i = 0; i < 3; i++) {
  const filename = `simulated-stack-d${i}.nii.gz`;
  const bytes = await readFile(resolve(stackDirectory, filename));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const assetUrl = examples[0].files.find(file => file.name === `stack-d${i}.nii.gz`).url;
  const pinned = lock.assets[assetUrl];
  if (!pinned || pinned.sha256 !== sha256 || pinned.bytes !== bytes.byteLength) throw new Error(`Pinned example integrity failed: ${filename}`);
  const full = decodeStacks([{ image: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), thickness: 3 }])[0];
  const first = Math.floor(full.shape[2] / 2) - 2;
  const pixels = full.shape[0] * full.shape[1];
  const data = full.data.slice(first * pixels, (first + 5) * pixels);
  const mask = full.mask.slice(first * pixels, (first + 5) * pixels);
  // Retain empty boundary slices so full-stack transform propagation is exercised.
  mask.fill(0, 0, pixels);
  mask.fill(0, 4 * pixels);
  stacks.push({ data: Array.from(data), mask: Array.from(mask), shape: [full.shape[0], full.shape[1], 5], resolution: full.resolution, thickness: 3, transforms: Array.from(full.transforms.slice(first * 12, (first + 5) * 12)) });
  fixture.push({ filename, sha256, assetUrl, originalShape: full.shape, retainedSliceRange: [first, first + 4], maskedSliceRange: [first + 1, first + 3], thicknessAssumptionMm: 3, mask: 'positive-intensity support, empty first and last retained slice' });
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Learned SVoRT pipeline verification</title>'); return; }
    const [directory, suffix] = path.startsWith('/models/') ? [modelDirectory, path.slice(8)] : path.startsWith('/runtime/') ? [runtimeDirectory, path.slice(9)] : [source, path.slice(1)];
    const filename = resolve(directory, suffix);
    if (relative(resolve(directory), filename).startsWith('..')) throw new Error('Invalid path');
    response.setHeader('Content-Type', { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }[extname(filename)] ?? 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.exposeFunction('reportProgress', value => console.error(JSON.stringify(value)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async serialized => {
    const { registerStacks, prepareRegistration } = await import('/packages/nesvor/src/registration/index.js');
    const { createOnnxLearnedStep } = await import('/packages/nesvor/src/registration/onnx.js');
    const runtime = await import('/runtime/ort.webgpu.min.mjs');
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.wasmPaths = new URL('/runtime/', location.href).href;
    const manifest = await (await fetch('/models/svort-manifest.json')).json();
    const stacks = serialized.map(s => ({ ...s, data: Float32Array.from(s.data), mask: Uint8Array.from(s.mask), transforms: Float64Array.from(s.transforms) }));
    const prepared = prepareRegistration(stacks);
    if (prepared.records.length !== 3 || prepared.records.some(r => r.cropped.shape[2] !== 3)) throw new Error('Expected three nonempty cropped slices per real stack');
    const learned = await createOnnxLearnedStep({ runtime, manifest, baseUrl: new URL('/models/', location.href).href, onProgress: value => { if (value.stage === 'svort-model') window.reportProgress(value); } });
    const iterations = [];
    const started = performance.now();
    try {
      const registered = await registerStacks(stacks, {
        mode: 'svort',
        learnedStep: async input => {
          const output = await learned(input);
          if (!output.theta.every(Number.isFinite) || !output.score.every(Number.isFinite)) throw new Error('Non-finite learned registration output');
          iterations.push({ iteration: input.iteration, count: input.count, sliceShape: input.sliceShape, scoreRange: [Math.min(...output.score), Math.max(...output.score)] });
          return output;
        },
        onProgress: value => window.reportProgress({ ...value, elapsedSeconds: (performance.now() - started) / 1000 }),
      });
      if (iterations.length !== 4) throw new Error('Did not execute all four learned SVoRT iterations');
      if (!Number.isFinite(registered.registration.scoreSvort) || !Number.isFinite(registered.registration.scoreStack)) throw new Error('Candidate selection requires finite NCC scores');
      let maximumTransformChange = 0;
      let maximumOrthogonalityError = 0;
      const propagatedBoundaryChanges = [];
      registered.stacks.forEach((stack, index) => {
        if (stack.transforms.length !== 5 * 12 || stack.shape.some((n, a) => n !== stacks[index].shape[a])) throw new Error('Full-stack geometry was not preserved');
        if (!stack.transforms.every(Number.isFinite) || !stack.data.every(Number.isFinite)) throw new Error('Non-finite registered stack');
        for (let z = 0; z < 5; z++) {
          const m = stack.transforms.subarray(z * 12, (z + 1) * 12);
          const change = Math.max(...Array.from(m, (v, i) => Math.abs(v - stacks[index].transforms[z * 12 + i])));
          maximumTransformChange = Math.max(maximumTransformChange, change);
          if (z === 0 || z === 4) propagatedBoundaryChanges.push(change);
          for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
            let dot = 0;
            for (let k = 0; k < 3; k++) dot += m[a * 4 + k] * m[b * 4 + k];
            maximumOrthogonalityError = Math.max(maximumOrthogonalityError, Math.abs(dot - Number(a === b)));
          }
        }
      });
      if (maximumTransformChange < 1e-3 || propagatedBoundaryChanges.some(x => x < 1e-3) || maximumOrthogonalityError > 1e-5) throw new Error('Learned registration did not produce valid nontrivial propagated rigid transforms');
      return { passed: true, elapsedSeconds: (performance.now() - started) / 1000, iterations, registration: registered.registration, maximumTransformChange, maximumOrthogonalityError, propagatedBoundaryChanges, originalStackShapes: stacks.map(s => s.shape), croppedStackShapes: prepared.records.map(r => r.cropped.shape), volumeShape: [200, 200, 200], upstreamComparison: false, clinicalValidation: false };
    } finally { await learned.release(); }
  }, stacks);
  console.log(JSON.stringify({ fixture, ...result }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

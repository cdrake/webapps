import test from 'node:test';
import assert from 'node:assert/strict';
import { requireHardwareAdapter, validateBrowserOutput } from '../scripts/verify-nesvor-browser.mjs';
import { writeVolume } from '../packages/synthsr/src/volume.js';

test('the full-acquisition browser gate rejects missing and software adapters', () => {
  for (const info of [null, {}, { vendor: 'google', architecture: 'swiftshader' }, { description: 'llvmpipe' }, { vendor: 'nvidia', fallback: true }]) assert.throws(() => requireHardwareAdapter(info));
  assert.doesNotThrow(() => requireHardwareAdapter({ vendor: 'nvidia', architecture: 'ampere' }));
});

test('the full-acquisition gate rejects reduced budgets and incomplete preprocessing', () => {
  const bytes = Buffer.from(writeVolume({ dims: [2,2,2], data: Float32Array.from([0,0,0,0,600,800,600,800]), affine: [[.8,0,0,0],[0,.8,0,0],[0,0,.8,0],[0,0,0,1]] }));
  const provenance = { engine: 'browser-webgpu', sourceCommit: '730ddaa3711a2304386de34193ea4b957892fe7b', config: { registration: 'svort', iterations: 6000, batchSize: 4096, samples: 256, log2Size: 19, outputResolution: .8 }, preprocessing: { segmentation: true, biasFieldCorrection: true }, outputSamples: 512 };
  assert.equal(validateBrowserOutput(bytes, provenance).mean, 700);
  const negative = Buffer.from(writeVolume({ dims: [2,2,2], data: Float32Array.from([700,-100,-100,-100,-100,-100,-100,-100]), affine: [[.8,0,0,0],[0,.8,0,0],[0,0,.8,0],[0,0,0,1]] }));
  assert.throws(() => validateBrowserOutput(negative, provenance), /negative/);
  for (const [key, value] of [['iterations',1],['batchSize',2],['samples',4],['log2Size',3],['registration','none']]) assert.throws(() => validateBrowserOutput(bytes, { ...provenance, config: { ...provenance.config, [key]: value } }));
  assert.throws(() => validateBrowserOutput(bytes, { ...provenance, preprocessing: { segmentation: false, biasFieldCorrection: true } }));
});

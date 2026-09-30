import { readFile } from 'node:fs/promises';
import { gaussianBlur, resample, makePSF } from './resampling.js';
import { registerVolume } from './stack-registration.js';
import { axisAngleToMatrix } from './geometry.js';

const reference = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (reference.source_commit !== '730ddaa3711a2304386de34193ea4b957892fe7b') throw new Error('Wrong upstream source.');
const data = Float32Array.from({ length: 4096 }, (_, i) => {
  const x = i % 16;
  const y = Math.floor(i / 16) % 16;
  const z = Math.floor(i / 256);
  return Math.exp(-((x - 7) ** 2 / 8 + (y - 6) ** 2 / 12 + (z - 8) ** 2 / 6)) + 0.5 * Math.exp(-((x - 11) ** 2 + (y - 10) ** 2 + (z - 6) ** 2) / 3);
});
const target = { data, shape: [16, 16, 16], resolution: [1, 1, 1], transform: axisAngleToMatrix([0, 0, 0, 0, 0, 0]) };
const result = await registerVolume({ ...target, transform: axisAngleToMatrix([0, 0, 0, 2, -1, 0]) }, target);
const psf = makePSF([1.25, 1.25, 3.75]);
const filtered = resample(gaussianBlur(data, [16, 16, 16], [1.5, 1, 0.5]), [16, 16, 16], [1, 1, 1], [2, 2, 2]);
const outputs = { transform: result.transform, loss: [result.loss], psf: psf.psf, blurredResampled: filtered.data };
const report = [];
for (const [name, values] of Object.entries(outputs)) {
  const expected = name === 'loss' ? [reference.loss] : reference[name];
  if (values.length !== expected.length) throw new Error(`${name} shape differs.`);
  const error = values.reduce((max, v, i) => Math.max(max, Math.abs(v - expected[i])), 0);
  const tolerance = name === 'transform' ? 2e-4 : 1e-5;
  if (!(error <= tolerance)) throw new Error(`${name}: ${error} > ${tolerance}`);
  report.push({ operation: name, maxAbsoluteError: error, tolerance });
}
console.log(JSON.stringify({ passed: true, report }, null, 2));

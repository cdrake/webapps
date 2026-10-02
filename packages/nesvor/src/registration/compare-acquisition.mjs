import { readFile } from 'node:fs/promises';
import { createAcquisition } from './acquisition.js';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (fixture.source_commit !== '730ddaa3711a2304386de34193ea4b957892fe7b') throw new Error('Wrong NeSVoR reference source.');
const report = [];
for (const entry of fixture.cases) {
  const operator = createAcquisition({ ...entry, transforms: Float64Array.from(entry.transforms) });
  const forward = operator.forward(entry.volume);
  const outputs = { forward: forward.data, weights: forward.weights, adjoint: operator.adjoint(entry.slices).data, equalized: operator.adjoint(entry.slices, { equalize: true }).data };
  for (const [name, output] of Object.entries(outputs)) {
    if (output.length !== entry[name].length) throw new Error('Reference shape differs.');
    const error = output.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - entry[name][i])), 0);
    if (!(error <= 1e-5)) throw new Error(`${entry.name} ${name}: ${error} > 1e-5`);
    report.push({ case: entry.name, operator: name, maxAbsoluteError: error });
  }
}
console.log(JSON.stringify({ passed: true, report }, null, 2));

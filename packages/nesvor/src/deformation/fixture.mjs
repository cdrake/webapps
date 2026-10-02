import { writeFile } from 'node:fs/promises';
import { createDeformationModel } from './model.js';
let seed = 42;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
const model = createDeformationModel({ boundingBox: [[-1, -2, -3], [1, 2, 3]], slices: 2, features: 2, embeddingFeatures: 3, log2Size: 2, coarsest: 64, finest: 32, width: 5 }, random);
for (const p of model.parameters) for (let i = 0; i < p.values.length; i++) p.values[i] = (random() - 0.5) * 0.7;
const count = 35;
const fixture = { config: model.config, boundingBox: model.boundingBox, slices: model.slices, parameters: model.parameters.map(p => Array.from(p.values)), xyz: Array.from({ length: count * 3 }, (_, i) => (random() - 0.5) * (i % 3 + 1)), sliceIndices: Array.from({ length: count }, (_, i) => i % 2), xyzGradient: Array.from({ length: count * 3 }, () => (random() - 0.5) / count), regularizationWeights: Array.from({ length: count }, (_, i) => i % 4 === 0 ? 0.1 / count : 0) };
await writeFile(process.argv[2], JSON.stringify(fixture));

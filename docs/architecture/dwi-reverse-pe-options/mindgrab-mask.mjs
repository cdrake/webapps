// Brain mask with MindGrab on the CPU, through @neurodesk/node-drivers.
// Usage: node mindgrab-mask.mjs <in.nii[.gz]> <mask-out.nii[.gz]> [brain-out.nii[.gz]]
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadMindgrabCpu } from './node-drivers/mindgrab.js';

const [input, maskOut, brainOut] = process.argv.slice(2);
const gz = (b) => b[0] === 0x1f && b[1] === 0x8b;
const encode = (buffer, path) => {
  const bytes = new Uint8Array(buffer);
  const raw = gz(bytes) ? gunzipSync(bytes) : bytes;
  return path.endsWith('.gz') ? gzipSync(raw) : raw;
};

const mindgrab = await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));
const { image, mask } = await mindgrab.segment(await readFile(input), { model: 'mindgrab', mask: true });
await writeFile(maskOut, encode(mask, maskOut));
if (brainOut) await writeFile(brainOut, encode(image, brainOut));

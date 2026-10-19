// The browser's niimath runner (src/runner.js) under Node: the same fit as the command line's
// runner, one call at a time, and a failed call does not block the next one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { runNiimath as runNode } from '@neurodesk/node-drivers/niimath';
import createNiimath from '@niivue/niimath/niimath.js';
import { runNiimath } from '../src/runner.js';
import { fitTensor } from '../src/tensor.js';

const DIRECTIONS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [Math.SQRT1_2, Math.SQRT1_2, 0], [Math.SQRT1_2, 0, Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]];

// A float32 NIfTI-1 on a 1 mm 4^3 grid: one tensor with eigenvalues 1.5, 0.5, 0.5 um^2/ms, b = 1000.
function dwi() {
  const voxels = 4 ** 3;
  const bytes = Buffer.alloc(352 + voxels * DIRECTIONS.length * 4);
  bytes.writeInt32LE(348, 0);
  [4, 4, 4, 4, DIRECTIONS.length, 1, 1, 1].forEach((dim, i) => bytes.writeInt16LE(dim, 40 + 2 * i));
  bytes.writeInt16LE(16, 70);
  bytes.writeInt16LE(32, 72);
  for (let i = 0; i < 8; i += 1) bytes.writeFloatLE(1, 76 + 4 * i);
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  bytes.writeInt16LE(1, 254);
  for (const offset of [280, 300, 320]) bytes.writeFloatLE(1, offset);
  bytes.write('n+1\0', 344, 'latin1');
  DIRECTIONS.forEach(([x, y, z], frame) => {
    const value = 1000 * Math.exp(-1000 * (0.0015 * x * x + 0.0005 * y * y + 0.0005 * z * z));
    for (let voxel = 0; voxel < voxels; voxel += 1) bytes.writeFloatLE(value, 352 + 4 * (frame * voxels + voxel));
  });
  return {
    dwi: gzipSync(bytes),
    bval: Buffer.from(DIRECTIONS.map((_, i) => (i ? 1000 : 0)).join(' ')),
    bvec: Buffer.from([0, 1, 2].map((axis) => DIRECTIONS.map((d) => d[axis]).join(' ')).join('\n')),
  };
}

test('the cached runner fits the tensor as the command line runner does', async () => {
  const input = dwi();
  const browser = await fitTensor(runNiimath, input);
  const node = await fitTensor((args, files) => runNode(createNiimath, args, files), input);
  for (const map of ['FA', 'MD', 'L1', 'S0', 'V1']) assert.deepEqual(Buffer.from(browser[map]), Buffer.from(node[map]), map);
  // A second fit on the cached module gives the same maps: each call removes its files.
  const again = await fitTensor(runNiimath, input);
  assert.deepEqual(Buffer.from(again.FA), Buffer.from(browser.FA));
});

test('the runner takes one call at a time and recovers from a failed call', async () => {
  const input = dwi();
  const first = fitTensor(runNiimath, input);
  await assert.rejects(fitTensor(runNiimath, input), /niimath is busy/);
  await first;
  await assert.rejects(runNiimath(['missing.nii.gz', '-add', '0', 'out.nii.gz'], { outputs: ['out.nii.gz'] }), /failed|exit/);
  const maps = await fitTensor(runNiimath, input);
  assert.ok(maps.FA.length > 0);
});

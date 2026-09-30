import test from 'node:test';
import assert from 'node:assert/strict';
import { resizePlanes, prepareStack, augmentationShape, postprocessMask, segmentStacks } from './index.js';

test('align-corners resampling and unbiased global normalization', () => {
  assert.deepEqual([...resizePlanes(new Float32Array([0, 2, 4, 6]), 2, 2, 3, 3)], [0, 1, 2, 2, 3, 4, 4, 5, 6]);
  const image = prepareStack({ data: new Float32Array([0, 2, 4, 6]), shape: [2, 2, 1], resolution: [.8, .8] });
  assert.ok(Math.abs(image.data.reduce((sum, x) => sum + x * x, 0) - 3) < 1e-6);
});

test('padding follows the pinned wrapper and rejects its negative-padding defect', () => {
  assert.deepEqual(augmentationShape(200, 300, false), { width: 200, height: 300, paddedWidth: 512, paddedHeight: 448, left: 156, top: 74 });
  assert.throws(() => augmentationShape(600, 100, false), /negative-padding/);
});

test('mask uses eight-connected components, first-label ties, and relative slice cutoff', () => {
  const logits = new Float32Array(3 * 2 * 25);
  for (const index of [0, 6, 12, 18, 24]) logits[25 + index] = 1;
  logits[3 * 25 + 4] = 1;
  logits[5 * 25 + 0] = 1;
  logits[5 * 25 + 24] = 1;
  const mask = postprocessMask(logits, 5, 5, 3, { radius: 0, thresholdSmall: .3 });
  assert.equal(mask.slice(0, 25).reduce((a, b) => a + b, 0), 5);
  assert.equal(mask.slice(25).reduce((a, b) => a + b, 0), 0);
});

test('eight augmentations invert both logits and coordinates then intersect existing mask', async () => {
  const data = new Float32Array([0, 0, 0, 0, 10, 10, 0, 10, 10]);
  const existing = new Uint8Array(9).fill(1);
  existing[8] = 0;
  let runs = 0;
  const infer = async (input) => {
    runs++;
    const logits = new Float32Array(input.length * 2);
    logits.set(input, input.length);
    return logits;
  };
  const [stack] = await segmentStacks([{ data, shape: [3, 3, 1], resolution: [.8, .8], mask: existing }], { infer, radius: 0 });
  assert.equal(runs, 8);
  assert.deepEqual([...stack.mask], [0, 0, 0, 0, 1, 1, 0, 1, 0]);
  assert.equal(existing[4], 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSegmentationResult } from '../src/segmentation.ts';

test('segmentation worker boundary rejects empty images, unknown backends and invalid timings', () => {
  const valid = { image: new ArrayBuffer(352), backend: 'cpu', elapsedMs: 12 };
  for (const value of [null, {}, { ...valid, image: new ArrayBuffer(0) }, { ...valid, image: 'nifti' }, { ...valid, backend: 'guess' }, { ...valid, elapsedMs: NaN }, { ...valid, elapsedMs: -1 }]) {
    assert.throws(() => parseSegmentationResult(value));
  }
  assert.deepEqual(parseSegmentationResult(valid), valid);
});

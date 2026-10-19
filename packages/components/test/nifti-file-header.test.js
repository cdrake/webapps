import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describeNiftiFile, parseNiftiHeader, readNiftiHeader } from '../src/file-io/NiftiUtils.js';

function header(dims = [1024, 1024, 512], littleEndian = true) {
  const bytes = new Uint8Array(352);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, littleEndian);
  [3, ...dims, 1, 1, 1, 1].forEach((size, axis) => view.setInt16(40 + axis * 2, size, littleEndian));
  view.setInt16(70, 4, littleEndian);
  view.setInt16(72, 16, littleEndian);
  view.setFloat32(108, 352, littleEndian);
  bytes.set([110, 43, 49, 0], 344);
  return bytes;
}

test('reads only 352 bytes of a sparse 1 GiB NIfTI file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'nifti-header-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'large.nii');
  const file = await open(path, 'w');
  try {
    await file.write(header());
    await file.truncate(352 + 1024 ** 3);
  } finally {
    await file.close();
  }
  const blob = await openAsBlob(path);
  blob.arrayBuffer = () => { throw new Error('Must not read the whole image'); };
  blob.stream = () => { throw new Error('An uncompressed header needs no stream'); };
  const reads = [];
  const slice = blob.slice.bind(blob);
  blob.slice = (start, end) => { reads.push([start, end]); return slice(start, end); };
  assert.deepEqual(await readNiftiHeader(blob), parseNiftiHeader(header()));
  assert.deepEqual(reads, [[0, 352]]);
});

test('streams gzip past a long comment and cancels before reading all voxel data', async () => {
  const bytes = header();
  const gzip = gzipSync(Buffer.concat([bytes, randomBytes(2 * 1024 ** 2)]));
  // A valid gzip FCOMMENT can put the compressed header beyond a fixed 64 KiB prefix.
  gzip[3] |= 16;
  const compressed = Buffer.concat([gzip.subarray(0, 10), Buffer.alloc(70000, 65), Buffer.from([0]), gzip.subarray(10)]);
  const file = new File([compressed], 'large.nii.gz');
  file.arrayBuffer = () => { throw new Error('Must not read the whole gzip'); };
  let readBytes = 0;
  let cancelled = false;
  file.stream = () => new ReadableStream({
    pull(controller) {
      const next = Math.min(readBytes + 4096, compressed.length);
      controller.enqueue(compressed.subarray(readBytes, next));
      readBytes = next;
      if (next === compressed.length) controller.close();
    },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await readNiftiHeader(file), parseNiftiHeader(bytes));
  // Cancellation propagates through pipeThrough asynchronously.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.ok(readBytes < compressed.length, `${readBytes} of ${compressed.length} compressed bytes read`);
});

for (const littleEndian of [true, false]) {
  test(`keeps singleton z and raw dimensions (${littleEndian ? 'little' : 'big'} endian)`, async () => {
    const file = new File([header([10, 12, 1], littleEndian)], 'slice.nii');
    const result = await readNiftiHeader(file);
    assert.deepEqual([result.nx, result.ny, result.nz], [10, 12, 1]);
    assert.deepEqual((await describeNiftiFile(file)).dims, [10, 12]);
  });
}

for (const bytes of [new Uint8Array(20), new Uint8Array(352)]) {
  test(`rejects an invalid ${bytes.length}-byte header`, async () => {
    await assert.rejects(readNiftiHeader(new Blob([bytes])), /Input must be a NIfTI-1 image/);
  });
}

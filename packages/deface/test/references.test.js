import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REFERENCE_URL, packMask, referenceMask, sha256, unpackMask } from '../validation/cases.mjs';

const voxels = Uint8Array.of(1, 0, 0, 1, 1, 0, 1, 0, 1);
const packed = packMask(voxels);
const pin = {
  url: `https://huggingface.co/datasets/neurodeskorg/webapps/resolve/${'a'.repeat(40)}/deface/reference.mask.gz`,
  sha256: sha256(packed),
  bytes: packed.length,
};

async function cache(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'deface-reference-test-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return { cacheDir };
}

test('a pinned mask downloads once and works from a verified cache without network access', async (t) => {
  const options = await cache(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, pin.url);
    return new Response(packed);
  });
  assert.deepEqual(unpackMask(await referenceMask(pin, options), voxels.length), voxels);
  fetch.mock.mockImplementation(() => { throw new Error('offline'); });
  assert.deepEqual(unpackMask(await referenceMask(pin, options), voxels.length), voxels);
  assert.equal(fetch.mock.callCount(), 1);
});

test('a same-size corrupted cached mask is re-downloaded and reverified', async (t) => {
  const options = await cache(t);
  const path = join(options.cacheDir, `${pin.sha256}.mask.gz`);
  const corrupted = Buffer.from(packed);
  corrupted[10] ^= 1;
  await writeFile(path, corrupted);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(packed));
  assert.deepEqual(unpackMask(await referenceMask(pin, options), voxels.length), voxels);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await readFile(path), packed);
});

test('an unverified remote mask is never stored or returned', async (t) => {
  const options = await cache(t);
  const corrupted = Buffer.from(packed);
  corrupted[10] ^= 1;
  t.mock.method(globalThis, 'fetch', async () => new Response(corrupted));
  await assert.rejects(referenceMask(pin, options), /failed checksum verification/);
  await assert.rejects(referenceMask({ ...pin, bytes: pin.bytes + 1 }, options), /failed checksum verification/);
  assert.deepEqual(await readdir(options.cacheDir), []);
});

test('mutable or incomplete reference pins fail before a download', async (t) => {
  const options = await cache(t);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected download'); });
  for (const invalid of [undefined, { ...pin, url: pin.url.replace('a'.repeat(40), 'main') }, { ...pin, sha256: '' }, { ...pin, bytes: 0 }]) {
    await assert.rejects(referenceMask(invalid, options), /immutable Hugging Face URL, SHA-256 and byte-size pin/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('every recorded browser mask has an external pin and no packed mask is stored in the source tree', async () => {
  const reference = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));
  assert.equal(Object.values(reference.cases).filter(({ mask }) => mask).length, 2);
  for (const [id, item] of Object.entries(reference.cases)) {
    if (!item.mask) continue;
    assert.equal(item.maskReference.file, `${id}.mask.gz`);
    assert.match(item.maskReference.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[a-f0-9]{40}\//);
    assert.match(item.maskReference.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.maskReference.bytes) && item.maskReference.bytes > 0);
  }
  const files = await readdir(new URL('../validation/', import.meta.url), { recursive: true });
  assert.deepEqual(files.filter((file) => file.endsWith('.mask.gz')), []);
});

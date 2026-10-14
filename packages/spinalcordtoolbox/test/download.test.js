import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadModels } from '../src/node.js';

test('a download that does not match the pinned model leaves nothing behind', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'sct-webapp-download-'));
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    return new Response('not the model');
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    await rm(cacheDir, { recursive: true, force: true });
  });
  await assert.rejects(downloadModels({ tasks: ['graymatter'], cacheDir }), /sct-graymatter\.onnx download failed SHA-256 verification/);
  assert.deepEqual(requested, ['https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/55c9462a14bc9c84cf093c348cffda9148099df9/web/models/sct-graymatter.onnx']);
  assert.deepEqual(await readdir(cacheDir), []);
});

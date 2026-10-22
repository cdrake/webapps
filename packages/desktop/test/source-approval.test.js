import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { grantSources, parseApprovedSources, sourceOf } from '../src/source-approval.js';

test('sources are local files, remote addresses or nothing to approve', () => {
  const file = join(tmpdir(), 'T2.nii.gz');
  assert.deepEqual(sourceOf(file), { path: file });
  assert.deepEqual(sourceOf(pathToFileURL(file).href), { path: file });
  assert.deepEqual(sourceOf('https://example.org/data/T2.nii.gz'), { url: 'https://example.org/data/T2.nii.gz' });
  for (const value of ['T1.nii.gz', './sample/T1.nii.gz', 'data:application/octet-stream;base64,AA==', 'blob:http://127.0.0.1/x']) {
    assert.equal(sourceOf(value), null, value);
  }
});

test('every url in tool arguments is granted in order, at any depth', async () => {
  const asked = [];
  const params = { url: 'a', name: 'url', layers: [{ url: 'b', opacity: 1 }, { url: 'c' }], args: { url: 'd', meta: { url: 7 } } };
  const granted = await grantSources(params, async value => { asked.push(value); return `granted:${value}`; });
  assert.deepEqual(asked, ['a', 'b', 'c', 'd']);
  assert.deepEqual(granted, { url: 'granted:a', name: 'url', layers: [{ url: 'granted:b', opacity: 1 }, { url: 'granted:c' }],
    args: { url: 'granted:d', meta: { url: 7 } } });
  await assert.rejects(grantSources({ layers: [{ url: 'x' }] }, async () => { throw new Error('denied'); }), /denied/);
});

test('pre-approved sources cover files inside a directory and URLs under a prefix', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'approved-sources-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'runs'));
  await writeFile(join(root, 'runs', 'mask.nii.gz'), '');
  const approved = parseApprovedSources(`${join(root, 'runs')}, ${join(root, 'later')}, https://example.org/open/`);
  assert.equal(await approved.permits({ file: join(root, 'runs', 'mask.nii.gz') }), true);
  assert.equal(await approved.permits({ file: join(root, 'runs') }), false);
  assert.equal(await approved.permits({ file: join(root, 'runs-private', 'x.nii') }), false);
  assert.equal(await approved.permits({ file: join(root, 'later', 'x.nii') }), false);
  await mkdir(join(root, 'later'));
  assert.equal(await approved.permits({ file: join(root, 'later', 'x.nii') }), true, 'a directory created after startup counts');
  assert.equal(await approved.permits({ url: 'https://example.org/open/T1.nii.gz' }), true);
  assert.equal(await approved.permits({ url: 'https://example.org/closed/T1.nii.gz' }), false);
  assert.equal(await parseApprovedSources(undefined).permits({ url: 'https://example.org/open/T1.nii.gz' }), false);
  assert.throws(() => parseApprovedSources('relative/dir'), /absolute directories or http\(s\) URLs/);
});

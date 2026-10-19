import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readNiftiHeader } from '../../../packages/components/src/file-io/NiftiUtils.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('async function loadFiles(');
const end = source.indexOf('\nfunction importFiles(', start);
assert.ok(start >= 0 && end > start);

async function load(dims) {
  const bytes = new Uint8Array(352);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [3, ...dims, 1, 1, 1, 1].forEach((size, axis) => view.setInt16(40 + axis * 2, size, true));
  const file = new File([bytes], 'flair.nii');
  file.arrayBuffer = () => { throw new Error('Full-file arrayBuffer called'); };
  const elements = new Map();
  const finished = [];
  const shown = [];
  const context = vm.createContext({
    readNiftiHeader,
    MAX_INPUT_VOXELS: 1000000,
    readImageFiles: async files => files,
    begin: () => ({ controller: new AbortController() }),
    closeEdit() {},
    renderOutputs() {},
    end: (_current, message, options) => finished.push({ message, options }),
    show: async stage => shown.push(stage),
    $: id => {
      if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', classList: { add() {}, remove() {} } });
      return elements.get(id);
    },
  });
  vm.runInContext(`let job = null, source, outputs, viewRevision = 0; ${source.slice(start, end)}`, context);
  await context.loadFiles(() => Promise.resolve([file]));
  return { elements, finished, shown };
}

for (const dims of [[32, 32, 16], [32, 32, 1]]) {
  test(`loading ${dims.join(' × ')} displays raw dimensions without a full-file read`, async () => {
    const { elements, finished, shown } = await load(dims);
    assert.equal(elements.get('fileInfo').textContent, `flair.nii · ${dims.join(' × ')} voxels`);
    assert.equal(elements.get('fileInfo').hidden, false);
    assert.equal(finished[0].message, 'FLAIR loaded · ready to segment lesions');
    assert.deepEqual(shown, ['flair']);
  });
}

test('the raw dimensions still enforce the input voxel limit before displaying an image', async () => {
  const { elements, finished, shown } = await load([1024, 1024, 512]);
  assert.equal(elements.get('fileInfo').hidden, true);
  assert.equal(finished[0].message, 'Unsupported image dimensions.');
  assert.equal(finished[0].options.error, true);
  assert.deepEqual(shown, []);
});

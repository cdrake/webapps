import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadNoddi } from '../src/wasm.js';

const fixture = JSON.parse(await readFile(new URL('../../../exes/dwi/dmipy/tests/fixtures/oracle.json', import.meta.url), 'utf8'));
const bvecs = [0, 1, 2].map(axis => fixture.gradients.map(row => row[axis]));

test('the actual dmipy WASM fits source-oracle signals and reports skipped voxels', async () => {
  const api = await loadNoddi(await readFile(new URL('../src/noddi.wasm', import.meta.url)));
  const model = api.noddiModel(fixture.bvals, bvecs, { method: 'dmipy' });
  try {
    const voxels = fixture.cases.length + 1;
    const data = new Float32Array(voxels * fixture.bvals.length);
    fixture.cases.forEach((row, voxel) => row.measured.forEach((value, frame) => { data[frame * voxels + voxel] = value; }));
    const maps = model.fit(data, voxels);
    for (let voxel = 0; voxel < fixture.cases.length; voxel++) {
      const expected = fixture.cases[voxel].fitted;
      for (const [key, column] of [['OD', 2], ['ICVF', 3], ['ISOVF', 4]]) {
        assert.ok(Math.abs(maps[key][voxel] - expected[column]) < 2e-5, `voxel${voxel} ${key}`);
      }
      const norm = Math.hypot(maps.dirx[voxel], maps.diry[voxel], maps.dirz[voxel]);
      assert.ok(Math.abs(norm - 1) < 1e-6);
    }
    for (const values of Object.values(maps)) assert.equal(values.at(-1), 0);
    assert.deepEqual(model.diagnostics, { fitted: 16, skipped: 1, nonconverged: 0, failed: 0 });
  } finally { model.free(); }
  assert.throws(() => model.fit(new Float32Array(fixture.bvals.length), 1), /freed/);
  assert.throws(() => api.noddiModel(fixture.bvals, bvecs, { method: 'unknown' }), /amico or dmipy/);
});

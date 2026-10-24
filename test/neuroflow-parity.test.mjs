import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { resolveStepInputs, scientificProvenance } from '../scripts/lib/neuroflow-parity.mjs';

test('individual app comparisons resolve the exact chain files and constant settings', () => {
  const step = { inputs: {
    input_dwi: { ref: 'steps.correct.outputs.output_dwi' },
    input_mask: { ref: 'inputs.mask' },
    param_iterations: { constant: 20 },
  } };
  assert.deepEqual(resolveStepInputs(step, { mask: '/fixed/mask.nii.gz' }, { correct: { output_dwi: '/chain/corrected.nii.gz' } }),
    { input_dwi: '/chain/corrected.nii.gz', input_mask: '/fixed/mask.nii.gz', param_iterations: 20 });
  assert.throws(() => resolveStepInputs(step, {}, {}), /Missing fixed input/);
});

test('parity excludes execution durations and retains acquisition timing and scientific settings', () => {
  assert.deepEqual(scientificProvenance({ elapsedMs: 10, fitSeconds: 2, model: { seconds: 4, Seconds: 5, iterations: 20 }, acquisition: { EchoTime: 0.08, RepetitionTime: 3 } }),
    { model: { iterations: 20 }, acquisition: { EchoTime: 0.08, RepetitionTime: 3 } });
  assert.notDeepEqual(scientificProvenance({ acquisition: { EchoTime: 0.08 } }), scientificProvenance({ acquisition: { EchoTime: 0.09 } }));
});

test('archive evidence distinguishes timestamps from scientific member differences', async t => {
  const { createRequire } = await import('node:module');
  const { dirname } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { zipEvidence } = await import('../scripts/lib/neuroflow-parity.mjs');
  const require = createRequire(new URL('../apps/dwi2trx/package.json', import.meta.url));
  const entry = require.resolve('@dipy/gpu-streamlines');
  const { zipSync } = await import(pathToFileURL(require.resolve('fflate', { paths: [dirname(entry)] })));
  const root = await mkdtemp(join(tmpdir(), 'archive-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const header = Buffer.from(JSON.stringify({ NB_VERTICES: 1, NB_STREAMLINES: 1 }));
  const members = { 'header.json': header, 'positions.3.float32': new Uint8Array(new Float32Array([1, 2, 3]).buffer) };
  const first = join(root, 'first.trx');
  const later = join(root, 'later.trx');
  const changed = join(root, 'changed.trx');
  await writeFile(first, zipSync(members, { level: 0, mtime: new Date(2020, 0, 1) }));
  await writeFile(later, zipSync(members, { level: 0, mtime: new Date(2021, 0, 1) }));
  await writeFile(changed, zipSync({ ...members, 'positions.3.float32': new Uint8Array(new Float32Array([1, 2, 4]).buffer) }, { level: 0, mtime: new Date(2020, 0, 1) }));
  const a = await zipEvidence(first);
  const b = await zipEvidence(later);
  const c = await zipEvidence(changed);
  assert.notEqual(a.sha256, b.sha256);
  assert.deepEqual(a.members, b.members);
  assert.deepEqual(a.members['header.json'].header, { NB_VERTICES: 1, NB_STREAMLINES: 1 });
  assert.notEqual(a.members['positions.3.float32'].sha256, c.members['positions.3.float32'].sha256);
  assert.match(a.metadata, /20200101/);
});

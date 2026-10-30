import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArguments, writeMatTransform } from '@neurodesk/hmc-registration';
import { loadGreedySingleThread } from '@neurodesk/greedy/single';
import { loadHmcRegistration } from '@neurodesk/hmc-registration/node';
import { createFloat32Nifti, createNiftiHeaderFromVolume, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import {
  applyArguments,
  flairToT1,
  greedyMatrixToMat,
  niftiName,
  nonlinearArguments,
  templateToFlair,
  templateToT1,
  templateToT1Linear,
} from '../src/register.js';

const count = (argv, token) => argv.filter((value) => value === token).length;
const valueAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

const REGISTRATIONS = {
  nonlinear: nonlinearArguments({ fixed: 'template.nii.gz', moving: 't1_vp.nii', initial: 'lin.mat', output: 'nl_', seed: 7 }),
};

test('every antsRegistration argv has one --float 1 and one --random-seed', () => {
  for (const [name, argv] of Object.entries(REGISTRATIONS)) {
    assert.equal(count(argv, '--float'), 1, name);
    assert.equal(valueAfter(argv, '--float'), '1', name);
    assert.equal(count(argv, '--random-seed'), 1, name);
    assert.equal(valueAfter(argv, '--random-seed'), '7', name);
    assert.doesNotThrow(() => checkArguments(argv), name);
  }
});

test('the nonlinear stages use correlation and follow the native tools', () => {
  const argv = REGISTRATIONS.nonlinear;
  const metrics = (list) => list.filter((_, i) => list[i - 1] === '--metric').map((metric) => metric.slice(0, metric.indexOf('[')));
  assert.deepEqual(metrics(argv), ['GC', 'CC']);
  assert.deepEqual(metrics(nonlinearArguments({ fixed: 'f.nii', moving: 'm.nii', initial: 'i.mat', output: 'o_', synMetric: 'Mattes' })), ['GC', 'Mattes']);
  assert.throws(() => nonlinearArguments({ fixed: 'f.nii', moving: 'm.nii', initial: 'i.mat', output: 'o_', synMetric: 'MI' }), /Unknown registration metric/);
  const transforms = argv.filter((_, i) => argv[i - 1] === '--transform');
  assert.deepEqual(transforms, ['Affine[0.1]', 'SyN[0.1,3,0]']);
  assert.equal(valueAfter(argv, '--initial-moving-transform'), 'lin.mat');
  // nlfit_s -level 2: the finest SyN level is shrink 2 on the 1 mm template.
  const shrinks = argv.filter((_, i) => argv[i - 1] === '--shrink-factors');
  assert.equal(shrinks.at(-1).split('x').at(-1), '2');
});

test('seeds outside the kernel range are refused', () => {
  for (const seed of [0, -1, 1.5, 2147483648, '3']) {
    assert.throws(() => nonlinearArguments({ fixed: 'f.nii', moving: 'm.nii', initial: 'i.mat', output: 'o_', seed }), /seed/);
  }
});

test('transform lists put the transform that acts first on the output point last', () => {
  assert.deepEqual(templateToT1Linear({ affine: 'lin.mat' }), ['inverse:lin.mat']);
  assert.deepEqual(templateToT1({ affine: 'nl.mat', inverseWarp: 'nl_inverse.nii.gz' }), ['nl_inverse.nii.gz', 'inverse:nl.mat']);
  assert.deepEqual(templateToFlair({ t1Affine: 'lin.mat', rigid: 'rigid.mat' }), ['inverse:lin.mat', 'inverse:rigid.mat']);
  assert.deepEqual(flairToT1({ rigid: 'rigid.mat' }), ['rigid.mat']);
});

test('applyArguments builds --apply argv and refuses unknown interpolation', () => {
  assert.deepEqual(
    applyArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o.nii', interpolation: 'BSpline[2]', transforms: ['a.mat'] }),
    ['--apply', 'f.nii', 'm.nii', 'o.nii', 'BSpline[2]', '0', 'a.mat'],
  );
  assert.throws(() => applyArguments({ fixed: 'f', moving: 'm', output: 'o', interpolation: 'Cubic', transforms: ['a.mat'] }), /interpolation/);
  assert.throws(() => applyArguments({ fixed: 'f', moving: 'm', output: 'o', interpolation: 'Linear', transforms: [] }), /transform/);
  assert.deepEqual(checkArguments(applyArguments({ fixed: 'f.nii', moving: 'm.nii', output: 'o.nii', interpolation: 'Linear', transforms: ['inverse:a.mat'] })).length, 7);
});

test('niftiName keeps .nii.gz for gzipped bytes', () => {
  assert.equal(niftiName('t1', new Uint8Array([0x1f, 0x8b, 8])), 't1.nii.gz');
  assert.equal(niftiName('t1', new Uint8Array([92, 1, 0])), 't1.nii');
});

const matFile = (parameters) => writeMatTransform({ transform: 'AffineTransform_double_3_3', parameters, fixed: [0, 0, 0] });

test('hmc --apply applies the last listed transform first', async () => {
  // A 3-voxel cube at k = 32 on a 1 mm identity grid; T moves +10 mm along z, S doubles z.
  // Last listed first: moving(T(S(p))), so the cube lands at 2k + 10 = 32, k = 11 (else k = 6).
  const n = 64;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } });
  const image = new Float32Array(n ** 3);
  for (let z = 31; z <= 33; z++) {
    for (let y = 31; y <= 33; y++) {
      for (let x = 39; x <= 41; x++) image[(z * n + y) * n + x] = 100;
    }
  }
  const ants = await loadHmcRegistration();
  const { outputs } = ants.run(['--apply', 'image.nii', 'image.nii', 'out.nii', 'Linear', '0', 'T.mat', 'S.mat'], {
    'image.nii': new Uint8Array(createFloat32Nifti(image, header)),
    'T.mat': matFile([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 10]),
    'S.mat': matFile([1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]),
  });
  const { data } = readNiftiImageData(outputs['out.nii']);
  let peak = 0;
  for (let i = 1; i < data.length; i++) if (data[i] > data[peak]) peak = i;
  assert.equal(Math.floor(peak / (n * n)), 11);
});

test('a Greedy matrix as .mat resamples through --apply as Greedy reslices with it', async () => {
  // An oblique, flipped 2 mm grid and a smooth image, so a sign or axis error moves the result.
  const n = 40;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine: [[-2, 0.2, 0, 38], [0.1, 2, 0, -41], [0, 0, 2, -37]] } });
  const image = new Float32Array(n ** 3).map((_, i) => {
    const [x, y, z] = [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)];
    return 100 * Math.exp(-((x - 18) ** 2 + (y - 22) ** 2 + (z - 20) ** 2) / 60) + x + 2 * y + 3 * z;
  });
  const bytes = new Uint8Array(createFloat32Nifti(image, header));
  // A rotation about z of 0.2 rad, a small shear and a translation, in RAS from fixed to moving.
  const [c, s] = [Math.cos(0.2), Math.sin(0.2)];
  const matrix = `${c} ${-s} 0.05 3\n${s} ${c} 0 -5\n0 0.03 1.1 2\n0 0 0 1\n`;
  const greedy = await loadGreedySingleThread();
  const expected = readNiftiImageData(greedy.reslice_affine_options(bytes, bytes, matrix, false, 0).buffer).data;
  const ants = await loadHmcRegistration();
  const { outputs } = ants.run(['--apply', 'image.nii', 'image.nii', 'out.nii', 'Linear', '0', 'greedy.mat'], { 'image.nii': bytes, 'greedy.mat': greedyMatrixToMat(matrix) });
  const { data } = readNiftiImageData(outputs['out.nii']);
  // The two differ only within a voxel of the moving image's edge, where Greedy blends in the
  // background and ITK does not interpolate: compare voxels whose neighbours both filled.
  const filled = (i) => data[i] !== 0 && expected[i] !== 0;
  const inner = (i) => [i % n, Math.floor(i / n) % n, Math.floor(i / n ** 2)].every((k) => k > 0 && k < n - 1);
  let compared = 0;
  for (let i = 0; i < data.length; i++) {
    if (!inner(i) || ![0, 1, -1, n, -n, n * n, -n * n].every((step) => filled(i + step))) continue;
    assert.ok(Math.abs(data[i] - expected[i]) < 1e-3, `voxel ${i}: ${data[i]} against ${expected[i]}`);
    compared++;
  }
  assert.ok(compared > n ** 3 / 3, `${compared} voxels compared`);
});

test('greedyMatrixToMat refuses text that is not a 4 x 4 matrix', () => {
  assert.throws(() => greedyMatrixToMat('1 0 0\n0 1 0\n0 0 1'), /four rows of four numbers/);
  assert.throws(() => greedyMatrixToMat('1 0 0 x\n0 1 0 0\n0 0 1 0\n0 0 0 1'), /four rows of four numbers/);
});

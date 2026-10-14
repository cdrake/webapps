import assert from 'node:assert/strict';
import test from 'node:test';
import { routeFiles } from '../src/ui/pageDrop.js';

const input = (kind, multiple = false) => ({ dataset: { neurodeskInput: kind }, multiple });
const file = name => ({ name });

test('scans fill empty single-file slots in order, then replace from the first', () => {
  const [fixed, moving] = [input('image'), input('image')];
  const two = routeFiles([file('a.nii'), file('b.nii')], [fixed, moving]);
  assert.deepEqual(two.map(([slot, files]) => [slot, files.map(f => f.name)]), [[fixed, ['a.nii']], [moving, ['b.nii']]]);
  const next = routeFiles([file('c.nii')], [fixed, moving], slot => slot === fixed);
  assert.equal(next[0][0], moving);
  const full = routeFiles([file('d.nii')], [fixed, moving], () => true);
  assert.equal(full[0][0], fixed);
});

test('files go to an input of their kind, or with the scans when none exists', () => {
  const [scan, gradients] = [input('image', true), input('gradients', true)];
  const plan = routeFiles([file('dwi.nii.gz'), file('dwi.bval'), file('dwi.bvec')], [scan, gradients]);
  assert.deepEqual(plan.map(([slot, files]) => [slot, files.length]), [[scan, 1], [gradients, 2]]);
  const together = routeFiles([file('dwi.nii.gz'), file('dwi.bval')], [scan]);
  assert.deepEqual(together.map(([slot, files]) => [slot, files.length]), [[scan, 2]]);
});

test('a DICOM series stays together in a multiple input', () => {
  const scan = input('image', true);
  const plan = routeFiles([file('1.dcm'), file('2.dcm'), file('3.dcm')], [scan, input('image')]);
  assert.deepEqual(plan.map(([, files]) => files.length), [3]);
});

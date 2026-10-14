import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { primaryInput, routeFiles } from '../src/ui/pageDrop.js';

const file = name => ({ name });

test('the primary input skips auxiliary kinds and disabled or folder inputs', () => {
  const { document } = new JSDOM(`<body>
    <input type="file" data-neurodesk-input="model" id="model">
    <input type="file" data-neurodesk-input="image" id="off" disabled>
    <input type="file" data-neurodesk-input="image" id="folder" webkitdirectory>
    <input type="file" data-neurodesk-input="dataset" id="spectra">
    <input type="file" data-neurodesk-input="image" id="t1"></body>`).window;
  assert.equal(primaryInput(document).id, 'spectra', 'LCModel: spectra, not the tissue T1');
  document.getElementById('spectra').remove();
  assert.equal(primaryInput(document).id, 't1');
});

test('auxiliary files go to their own input, everything else to the primary input', () => {
  const scan = { dataset: { neurodeskInput: 'image' } };
  const mask = { dataset: { neurodeskInput: 'image' } };
  const gradients = { dataset: { neurodeskInput: 'gradients' } };
  const plan = routeFiles([file('a.nii'), file('b.nii'), file('dwi.bval'), file('dwi.bvec')], [scan, mask, gradients], scan);
  assert.deepEqual(plan.map(([input, files]) => [input, files.map(f => f.name)]), [[scan, ['a.nii', 'b.nii']], [gradients, ['dwi.bval', 'dwi.bvec']]]);
  const noGradientInput = routeFiles([file('a.nii'), file('dwi.bval')], [scan, mask], scan);
  assert.deepEqual(noGradientInput.map(([input, files]) => [input, files.length]), [[scan, 2]]);
});

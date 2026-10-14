import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { bindPageDrop, primaryInput, routeFiles } from '../src/ui/pageDrop.js';

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

// jsdom has no DataTransfer; a drop carries file items and the input keeps whatever files it is given.
function dropSession(markup) {
  const { window } = new JSDOM(`<body>${markup}<footer id="status"></footer></body>`);
  // deliverFiles builds its events from the page's globals.
  Object.assign(globalThis, {
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    DataTransfer: class {
      items = { list: [], add: file => this.items.list.push(file) };
      get files() { return this.items.list; }
    },
  });
  const input = window.document.querySelector('input');
  Object.defineProperty(input, 'files', { get: () => input._files ?? [], set: files => { input._files = files; } });
  const pick = (...names) => {
    input.files = names.map(name => new window.File([], name));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const drop = async name => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    event.dataTransfer = { types: ['Files'], items: [{ getAsFile: () => new window.File([], name) }] };
    window.document.body.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve));
  };
  const undo = () => window.document.querySelector('.nd-status-undo');
  bindPageDrop(window.document);
  return { window, input, pick, drop, undo };
}

test('loading an example withdraws a pending Undo', async () => {
  const { window, input, pick, drop, undo } = dropSession('<input type="file" data-neurodesk-input="image">');
  pick('a.nii');
  await drop('b.nii');
  assert.ok(undo());
  input.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'ready' } }));
  assert.equal(undo(), null);
});

test('Undo restores an appending input as its app last reported it', async () => {
  const { window, input, pick, drop, undo } = dropSession('<input type="file" data-neurodesk-input="image" data-appends>');
  pick('a.nii');
  pick('b.nii');
  input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [new window.File([], 'b.nii')] } }));
  await drop('c.nii');
  undo().click();
  assert.deepEqual([...input.files].map(f => f.name), ['b.nii']);
});

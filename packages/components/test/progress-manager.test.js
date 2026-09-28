import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ProgressManager } from '../src/ui/ProgressManager.js';

function footer() {
  const { document } = new JSDOM(`<footer id="status">
    <span id="statusText" class="nd-status-text">Ready</span>
    <span id="elapsed" class="nd-status-elapsed"></span>
    <progress id="progress" max="1" value="0"></progress>
    <button id="cancelButton" class="nd-btn-cancel" hidden>×</button>
  </footer>`).window;
  const $ = (id) => document.getElementById(id);
  return { $, manager: new ProgressManager({ barElement: $('progress'), textElement: $('statusText'), elapsedElement: $('elapsed'), cancelElement: $('cancelButton') }) };
}

test('drives the design-system footer through a run', () => {
  const { $, manager } = footer();
  manager.begin('Segmenting…');
  assert.equal($('statusText').textContent, 'Segmenting…');
  assert.equal($('progress').hasAttribute('value'), false, 'indeterminate while no fraction is known');
  assert.equal($('cancelButton').hidden, false);
  assert.match($('elapsed').textContent, /^0:0\d$/);
  manager.setProgress(0.4, 'Patch 4 of 10');
  assert.equal($('progress').value, 0.4);
  assert.equal($('statusText').textContent, 'Patch 4 of 10');
  manager.end('Complete');
  assert.equal($('progress').value, 1);
  assert.equal($('cancelButton').hidden, true);
  assert.equal($('cancelButton').disabled, true);
  assert.notEqual($('elapsed').textContent, '', 'elapsed time stays visible after the run');
  manager.reset();
  assert.equal($('elapsed').textContent, '');
  assert.equal($('statusText').textContent, 'Ready');
});

test('a run that cannot be cancelled keeps the × hidden', () => {
  const { $, manager } = footer();
  manager.begin('Loading…', { cancellable: false });
  assert.equal($('cancelButton').hidden, true);
  manager.end('Failed', { success: false });
  assert.equal($('progress').value, 0);
  manager.stopTimer();
});

test('legacy div progress bars still animate by width', () => {
  const { document } = new JSDOM('<div id="progressBar" style="width:0"></div><span id="statusText"></span>').window;
  const manager = new ProgressManager({ barElement: document.getElementById('progressBar'), textElement: document.getElementById('statusText') });
  manager.setProgress(0.5, 'Half');
  assert.equal(document.getElementById('progressBar').style.width, '50%');
});

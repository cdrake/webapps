import test from 'node:test';
import assert from 'node:assert/strict';
import { createDicomConverter } from '../src/automation/index.js';

const moduleUrl = `data:text/javascript,${encodeURIComponent(`
export class Dcm2niix {
  init() {
    this.worker = new EventTarget();
    this.worker.terminate = () => globalThis.testDicom.terminated++;
    return globalThis.testDicom.init();
  }
  input(files) { this.files = files; return this; }
  run() { return globalThis.testDicom.run(this.files); }
}`)}`;

test('static converter preserves every generated File and terminates its worker', async t => {
  const files = [new File(['image'], 'image.nii'), new File(['{}'], 'image.json')];
  globalThis.testDicom = { terminated: 0, init: async () => {}, run: async () => files };
  t.after(() => { delete globalThis.testDicom; });
  const convert = createDicomConverter({ moduleUrl });
  assert.deepEqual(await convert([new File(['slice'], 'slice')]), files);
  assert.equal(globalThis.testDicom.terminated, 1);
});

test('abort terminates a converter whose init never settles', async t => {
  globalThis.testDicom = { terminated: 0, init: () => new Promise(() => {}), run: () => assert.fail('must not run') };
  t.after(() => { delete globalThis.testDicom; });
  const controller = new AbortController();
  const convert = createDicomConverter({ moduleUrl });
  const pending = convert([], { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(globalThis.testDicom.terminated, 1);
});

test('timeout prevents an expired initializer from starting conversion', async t => {
  let ready;
  globalThis.testDicom = { terminated: 0, init: () => new Promise(resolve => { ready = resolve; }), run: () => assert.fail('expired converter must not run') };
  t.after(() => { delete globalThis.testDicom; });
  const convert = createDicomConverter({ moduleUrl, timeoutMs: 5 });
  await assert.rejects(convert([]), /timed out/);
  ready();
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(globalThis.testDicom.terminated, 1);
});

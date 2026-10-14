// The web app's deface operation without its viewer: the same pipeline and browser runtimes
// (niimath's vendored WebAssembly worker, the shared MindGrab runtime in a module worker), with
// MindGrab held to its CPU backend so the result does not depend on the machine's GPU.
import { deface } from '../../src/pipeline.js';
import { createNiimathCommand, mindgrab } from '../../src/browser.js';

const niimath = createNiimathCommand();
const fetchBytes = async (path) => new Uint8Array(await (await fetch(path)).arrayBuffer());

globalThis.runCase = async ({ id, method }) => {
  const result = await deface({
    input: await fetchBytes('/input/example'),
    method,
    templates: { template: await fetchBytes('/input/template'), mask: await fetchBytes('/input/mask') },
    niimath,
    mindgrab,
    mindgrabOptions: { backend: 'cpu', assetPath: '/mindgrab/' },
  });
  const files = [result.image, ...(result.mask ? [result.mask] : [])];
  for (const file of files) {
    const response = await fetch(`/result/${id}/${file.name}`, { method: 'POST', body: file.bytes });
    if (!response.ok) throw new Error(`Could not post ${file.name}`);
  }
  return { files: files.map(({ name }) => name), provenance: result.provenance };
};

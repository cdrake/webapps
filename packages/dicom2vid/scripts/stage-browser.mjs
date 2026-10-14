// Copies the browser-free modules the web app imports into apps/dicom2vid/web/vendor/dicom2vid/.
// The Node-only modules (the command line and its libvpx encoder) stay behind.
import { cp, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_ONLY = new Set(['node.js', 'libav.js', 'encoder.js']);
const destination = new URL('../../../apps/dicom2vid/web/vendor/dicom2vid/src/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await cp(new URL('../src/', import.meta.url), destination, {
  recursive: true,
  filter: (path) => !NODE_ONLY.has(basename(path)),
});
console.log(`Staged the shared dicom2vid modules: ${fileURLToPath(destination)}`);

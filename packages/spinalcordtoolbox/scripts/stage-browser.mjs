// Stages the browser half of the package into the static SCT app, which has no
// bundler: web/vendor/spinalcordtoolbox/src/ (generated, git-ignored), with the
// workspace specifiers rewritten to the app's vendored webapp-components copy.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BROWSER_SOURCES = ['segment.js', 'inference-pipeline.js', 'lesion-analysis.js', 'totalspineseg.js'];
const SPECIFIERS = {
  '@neurodesk/webapp-components/worker': '../../webapp-components/src/worker/index.js',
  '@neurodesk/webapp-components/file-io/nifti': '../../webapp-components/src/file-io/NiftiUtils.js',
  '@neurodesk/webapp-components/volume': '../../webapp-components/src/volume/index.js',
};

const root = new URL('../../../', import.meta.url);
const destination = new URL('apps/spinalcordtoolbox/web/vendor/spinalcordtoolbox/src/', root);
await rm(new URL('../', destination), { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const name of BROWSER_SOURCES) {
  let source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  for (const [specifier, path] of Object.entries(SPECIFIERS)) {
    source = source.replaceAll(`'${specifier}'`, `'${path}'`);
  }
  if (/from '@neurodesk\//.test(source)) throw new Error(`${name} imports a workspace package the browser cannot resolve`);
  await writeFile(new URL(name, destination), source);
}
console.log(`Staged shared SCT segmentation: ${fileURLToPath(destination)}`);

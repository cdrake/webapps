// The web app's examples, the operations it offers and its recorded downloads, shared by both release
// checks: validation/cli-check.mjs for the command line and apps/niimath/e2e/reference.spec.js for the
// web app. browser-reference.json holds what the built web app downloaded.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const REFERENCE = new URL('./browser-reference.json', import.meta.url);
// examples.json pins the dataset revision but not file checksums, so the checks pin the bytes.
export const EXAMPLE_SHA256 = Object.freeze({
  'T1_head.nii.gz': '58220b40d179b7a93dd3ce231dd7afaa39989c75658b2b8e4c2f34abf8f16416',
  'chris_t2.nii.gz': '8b763fcadd7a9ae677d4c5cab86b32831c03cddf146504291e7a5082fd9feee1',
});
// The automation's default command, the command field's default, then the web app's example
// operations in menu order. test/commands.test.js holds this list to the app's sources.
export const COMMANDS = Object.freeze([
  '-s 2',
  '-dehaze 5 -dog 2 3.2',
  '-dehaze -5 -dog 2 3.2',
  '-dehaze -5',
  '-mesh -i m -b',
  '-fmedian',
  '-fmean',
  '-sobel',
  '-sobel_binary',
  '-otsu 5',
  '-recip',
  '-bitmap -x 0.33 0.66 -r -y 0.33 0.66 -r -z 0.33 0.66 basic.png',
  '-bitmap -y 0.33 0.66 -z 0.33 0.66 -X 0.5 -c viridis cross.png',
  '-bitmap -o 0.5 -c inferno optimal.png',
]);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The web app's download name for a command: a mesh, a bitmap or a gzipped NIfTI image.
export function downloadName(command) {
  const words = command.split(/\s+/);
  if (words.includes('-mesh')) return 'mesh.mz3';
  if (words.includes('-bitmap')) return 'bitmap.png';
  return 'image.nii.gz';
}

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

// Downloads (once) and verifies every example in apps/niimath/examples.json.
export async function pinnedExamples() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/niimath/examples.json', import.meta.url), 'utf8'));
  return Promise.all(examples.map(async (example) => {
    const [file] = example.files;
    return { id: example.id, name: file.name, path: await pinnedFile(file) };
  }));
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-niimath-validation', revision, file.name);
  const expected = EXAMPLE_SHA256[file.name];
  if (!expected) throw new Error(`${file.name} has no pinned SHA-256 in validation/reference.mjs`);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

// What the checks compare about one download: its size and bytes, and for a gzipped image the
// decompressed bytes, so a difference in compression alone can be told from one in the image.
export function summarize(bytes) {
  const summary = { bytes: bytes.length, sha256: sha256(bytes) };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) summary.decompressedSha256 = sha256(gunzipSync(bytes));
  return summary;
}

// Returns [passed, line] pairs comparing one download with the browser reference's.
export function compareWithBrowser(label, is, was) {
  const checks = [
    [is.sha256 === was.sha256, `${label} ${is.sha256.slice(0, 12)} (${is.bytes} bytes) identical to the browser's ${was.sha256.slice(0, 12)} (${was.bytes} bytes)`],
  ];
  if (was.decompressedSha256) {
    checks.push([is.decompressedSha256 === was.decompressedSha256, `${label} decompressed bytes identical to the browser's`]);
  }
  return checks;
}

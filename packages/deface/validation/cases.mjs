// The inputs and methods that the browser reference (browser-reference.mjs) records and the
// release check (cli-check.mjs) replays, and the measurements both compare. browser-reference.json
// pins what the browser produced; <case>.mask.gz holds each MindGrab mask for the Dice check.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const REFERENCE_URL = new URL('./browser-reference.json', import.meta.url);
export const maskUrl = (id) => new URL(`./masks/${id}.mask.gz`, import.meta.url);

const examples = JSON.parse(await readFile(new URL('../../../apps/deface/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));

// The app's example through both engines. The robustfov and border variants add one niimath
// operation each; Hellinger differs from the fast engine only by `-cost hel` and takes minutes.
export const CASES = [
  { id: 'example-allineate', method: 'allineate' },
  { id: 'example-allineate-robustfov', method: 'allineate_robustfov' },
  { id: 'example-mindgrab', method: 'mindgrab' },
  { id: 'example-mindgrab-robust8', method: 'mindgrab_robust8' },
];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The app's example, downloaded once into os.tmpdir() and checked against the offline-assets lock. */
export async function exampleInput() {
  const [file] = examples.find(({ id }) => id === 't1-head').files;
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(tmpdir(), 'neurodesk-deface-validation', pin.sha256, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === pin.sha256) return { name: file.name, path, bytes: cached };
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return { name: file.name, path, bytes };
}

const VOXEL_READERS = {
  2: (view, offset) => view.getUint8(offset),
  4: (view, offset) => view.getInt16(offset, true),
  8: (view, offset) => view.getInt32(offset, true),
  16: (view, offset) => view.getFloat32(offset, true),
  256: (view, offset) => view.getInt8(offset),
  512: (view, offset) => view.getUint16(offset, true),
};

/** An uncompressed NIfTI-1 file's grid and voxels, read with this directory's own parser. */
export function readNifti(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, true) !== 348) throw new Error('Not an uncompressed NIfTI-1 file.');
  const dims = [1, 2, 3].map((axis) => view.getInt16(40 + axis * 2, true));
  const datatype = view.getInt16(70, true);
  const read = VOXEL_READERS[datatype];
  if (!read) throw new Error(`Unexpected NIfTI datatype ${datatype}.`);
  const step = view.getInt16(72, true) / 8;
  const start = Math.round(view.getFloat32(108, true));
  const values = new Float64Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < values.length; i++) values[i] = read(view, start + i * step);
  return { dims, datatype, headerSha256: sha256(bytes.subarray(0, 352)), values };
}

/** A binary mask packed eight voxels to a byte and gzipped: the committed form of a reference mask. */
export function packMask(values) {
  const bits = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) bits[i >> 3] |= 1 << (i & 7);
  return gzipSync(bits, { level: 9 });
}

export function unpackMask(packed, length) {
  const bits = gunzipSync(packed);
  if (bits.length !== Math.ceil(length / 8)) throw new Error(`Packed mask holds ${bits.length * 8} voxels, expected ${length}.`);
  return Uint8Array.from({ length }, (_, i) => (bits[i >> 3] >> (i & 7)) & 1);
}

/** Dice of two masks on the same grid, and how many voxels they disagree on. */
export function dice(a, b) {
  let inA = 0;
  let inB = 0;
  let both = 0;
  for (let i = 0; i < a.length; i++) {
    inA += a[i] !== 0;
    inB += b[i] !== 0;
    both += a[i] !== 0 && b[i] !== 0;
  }
  return { dice: (2 * both) / (inA + inB), differing: inA + inB - 2 * both };
}

/** What a run wrote: each file's SHA-256, the defaced grid, and the mask's grid and voxel count. */
export function measureOutputs(files) {
  const image = readNifti(files.get('defaced.nii'));
  const measured = {
    files: [...files.keys()].sort(),
    sha256: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]).sort(([a], [b]) => (a < b ? -1 : 1))),
    image: { dims: image.dims, datatype: image.datatype, headerSha256: image.headerSha256, nonzero: image.values.reduce((sum, value) => sum + (value !== 0), 0) },
  };
  if (files.has('brain-mask.nii')) {
    const mask = readNifti(files.get('brain-mask.nii'));
    measured.mask = { dims: mask.dims, datatype: mask.datatype, headerSha256: mask.headerSha256, voxels: mask.values.reduce((sum, value) => sum + (value !== 0), 0) };
  }
  return measured;
}

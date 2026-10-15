// The web app's example sessions (apps/dicompare/examples.json), downloaded once into the
// temporary directory and checked against the SHA-256 pins in registry/offline-assets.lock.json.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = new URL('../../../', import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, repository), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const examples = await readJson('apps/dicompare/examples.json');

async function pinned(url, expected, path) {
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url}: SHA-256 differs from its pin`);
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
}

// Returns the example's directory; its DICOM files sort in examples.json order.
export async function exampleDirectory(id) {
  const example = examples.find((candidate) => candidate.id === id);
  if (!example) throw new Error(`apps/dicompare/examples.json has no example ${id}`);
  const { assets } = await readJson('registry/offline-assets.lock.json');
  const directory = join(tmpdir(), 'neurodesk-dicompare-validation', id);
  await mkdir(directory, { recursive: true });
  const names = example.files.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify([...names].sort())) throw new Error(`${id} files are not in sorted order`);
  for (const { url, name, role } of example.files) {
    if (role !== 'dicom') throw new Error(`${id}: unexpected example role ${role}`);
    const asset = assets[url];
    if (!asset) throw new Error(`${url} is not pinned in registry/offline-assets.lock.json`);
    await pinned(url, asset.sha256, join(directory, name));
  }
  return { directory, names };
}

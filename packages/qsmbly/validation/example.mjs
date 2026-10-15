// The web app's pinned example (apps/qsmbly/examples.json), laid out as the BIDS dataset QSMxT reads.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [example] = JSON.parse(await readFile(new URL('../../../apps/qsmbly/examples.json', import.meta.url), 'utf8'));
export const EXAMPLE = example;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Download (or reuse) every example file, verified against examples.json; returns { role, name, path }. */
export async function pinnedExample(directory = join(tmpdir(), 'qsmbly-validation-example')) {
  await mkdir(directory, { recursive: true });
  const files = [];
  for (const file of example.files) {
    const path = join(directory, file.name);
    let bytes = await readFile(path).catch(() => null);
    if (!bytes || sha256(bytes) !== file.sha256) {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== file.sha256) throw new Error(`${file.name} failed SHA-256 verification`);
      await writeFile(path, bytes);
    }
    files.push({ role: file.role, name: file.name, path });
  }
  return files;
}

/**
 * Copy the example into a new BIDS dataset at `root`; the file names are already BIDS names.
 * `phaseSidecar` adds fields to the phase image's JSON sidecar.
 */
export async function stageBids(files, root, { phaseSidecar = {} } = {}) {
  const [subject, session] = files[0].name.split('_');
  const anat = join(root, subject, session, 'anat');
  await mkdir(anat, { recursive: true });
  for (const file of files) {
    const destination = join(anat, file.name);
    if (file.name.endsWith('_part-phase_T2starw.json')) {
      const sidecar = JSON.parse(await readFile(file.path, 'utf8'));
      await writeFile(destination, `${JSON.stringify({ ...sidecar, ...phaseSidecar }, null, 2)}\n`);
    } else {
      await copyFile(file.path, destination);
    }
  }
  await writeFile(join(root, 'dataset_description.json'), `${JSON.stringify({ Name: 'QSMbly example', BIDSVersion: '1.8.0' })}\n`);
  return { subject, session };
}

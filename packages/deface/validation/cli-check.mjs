#!/usr/bin/env node
// Runs a deface command line on the app's pinned example with every case in browser-reference.json
// and holds its files to what the web app's pipeline wrote in Chromium. The browser ran niimath's
// vendored WebAssembly in its worker and MindGrab's published wrapper on its CPU backend; the
// command line runs the same builds through the Node drivers. niimath's output must be the
// browser's byte for byte. A MindGrab mask must reach Dice 0.99 with the browser's
// (downloaded from the pinned dataset), and when it is the browser's exactly, so must the defaced image.
//
//   node validation/cli-check.mjs [--executable PATH] [--only CASE,...]
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REFERENCE_URL, dice, exampleInput, measureOutputs, readNifti, referenceMask, unpackMask } from './cases.mjs';

const MINIMUM_DICE = 0.99;
const { values } = parseArgs({ options: { executable: { type: 'string' }, only: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/deface.js', import.meta.url))];
const only = values.only ? new Set(values.only.split(',')) : null;
const reference = JSON.parse(await readFile(REFERENCE_URL, 'utf8'));

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function files(directory) {
  const map = new Map();
  for (const name of (await readdir(directory)).sort()) map.set(name, new Uint8Array(await readFile(join(directory, name))));
  return map;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The release check runs with an empty home that must stay empty, so everything goes under the
// temporary directory, the templates included unless the launcher supplies its own.
const work = await mkdtemp(join(tmpdir(), 'deface-cli-check-'));
const env = { ...process.env, NEURODESK_DEFACE_MODEL_DIR: process.env.NEURODESK_DEFACE_MODEL_DIR ?? join(tmpdir(), 'neurodesk-deface-validation', 'templates') };
try {
  const example = await exampleInput();
  for (const [id, expected] of Object.entries(reference.cases)) {
    if (only && !only.has(id)) continue;
    const output = join(work, id);
    const started = Date.now();
    const run = spawnSync(command[0], [...command.slice(1), example.path, output, '--method', expected.method], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      check(false, `${id}: ${command.join(' ')} --method ${expected.method} exited with ${run.status}: ${run.stderr.trim()}`);
      continue;
    }
    const report = JSON.parse(run.stdout);
    console.log(`INFO ${id}: ${((Date.now() - started) / 1000).toFixed(1)} s, browser ${expected.seconds} s, ${JSON.stringify(report.provenance)}`);
    check(report.provenance.method === expected.method, `${id}: provenance names method ${report.provenance.method}`);
    const written = await files(output);
    const measured = measureOutputs(written);
    check(same(measured.files, expected.files), `${id}: outputs ${measured.files.join(', ')}`);
    const { nonzero, ...grid } = measured.image;
    const { nonzero: expectedNonzero, ...expectedGrid } = expected.image;
    check(same(grid, expectedGrid), `${id}: defaced.nii grid, datatype and header equal the browser's (${grid.dims.join(' x ')})`);
    console.log(`INFO ${id}: ${nonzero} nonzero voxels kept, browser ${expectedNonzero}`);
    if (!expected.mask) {
      check(measured.sha256['defaced.nii'] === expected.sha256['defaced.nii'], `${id}: defaced.nii identical to the browser's (${measured.sha256['defaced.nii'].slice(0, 16)})`);
      continue;
    }
    const mindgrab = report.provenance.mindgrab ?? {};
    check(mindgrab.version === reference.mindgrab && mindgrab.backend === 'cpu', `${id}: MindGrab ${mindgrab.version} on ${mindgrab.backend}, browser ${reference.mindgrab} on ${reference.backend}`);
    if (!measured.mask) {
      check(false, `${id}: brain-mask.nii missing`);
      continue;
    }
    check(same(measured.mask.dims, expected.mask.dims) && measured.mask.headerSha256 === expected.mask.headerSha256, `${id}: brain-mask.nii grid and header equal the browser's (${measured.mask.dims.join(' x ')})`);
    const mask = readNifti(written.get('brain-mask.nii')).values;
    const { dice: overlap, differing } = dice(mask, unpackMask(await referenceMask(expected.maskReference), mask.length));
    check(overlap >= MINIMUM_DICE, `${id}: brain-mask.nii Dice ${overlap.toFixed(6)} >= ${MINIMUM_DICE} with the browser's mask (${differing} voxels differ, ${measured.mask.voxels} in the mask, browser ${expected.mask.voxels})`);
    if (measured.sha256['brain-mask.nii'] === expected.sha256['brain-mask.nii']) {
      check(measured.sha256['defaced.nii'] === expected.sha256['defaced.nii'], `${id}: with the browser's mask, defaced.nii is identical to the browser's (${measured.sha256['defaced.nii'].slice(0, 16)})`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} deface command-line checks` : 'PASS deface command line matches the web app');
process.exitCode = failures.length ? 1 : 0;

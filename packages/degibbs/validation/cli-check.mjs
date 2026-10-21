#!/usr/bin/env node
// Runs a degibbs command line on every pinned example and compares each output with the web app's
// download, recorded in browser-reference.json by apps/degibbs/e2e/reference.spec.js.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ROLES, compareWithBrowser, pinnedExamples, readReference, summarize } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/degibbs.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const reference = await readReference();
const examples = await pinnedExamples();
check(
  JSON.stringify(reference.inputs) === JSON.stringify(Object.fromEntries(examples.map((e) => [e.id, Object.fromEntries(e.files.map((f) => [f.name, f.sha256]))]))),
  'reference was recorded from the pinned example inputs',
);

const self = spawnSync(command[0], [...command.slice(1), 'self-check'], { encoding: 'utf8' });
check(self.status === 0, `self-check passes: ${(self.stdout || self.stderr).trim().slice(0, 200)}`);

const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'degibbs-cli-check-'));
try {
  for (const example of examples) {
    const was = reference.browser.outputs[example.id];
    const image = example.files.find((file) => file.role === 'image');
    // The example's .bval and .bvec share the image's stem, so the command line pairs them itself.
    const output = join(work, example.id);
    const started = performance.now();
    const run = spawnSync(command[0], [...command.slice(1), image.path, output], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) throw run.error;
    const seconds = (performance.now() - started) / 1000;
    if (run.status !== 0) {
      check(false, `${example.id}: exited with ${run.status}: ${run.stderr.slice(-2000)}`);
      continue;
    }
    const expected = ROLES.filter((role) => was?.[role]).map((role) => was[role].name).sort();
    check(
      run.stdout.trim() === output && JSON.stringify((await readdir(output)).sort()) === JSON.stringify(expected),
      `${example.id}: writes ${expected.join(', ')} and prints the directory (${seconds.toFixed(1)} s)`,
    );
    const provenance = JSON.parse(run.stderr.trim().split(/\r?\n/).at(-1));
    check(
      JSON.stringify(provenance.sliceAxes) === JSON.stringify(reference.browser.provenance[example.id].sliceAxes),
      `${example.id}: slice axes ${provenance.sliceAxes} as the web app chose`,
    );
    for (const role of ROLES.filter((role) => was?.[role])) {
      const bytes = await readFile(join(output, was[role].name)).catch(() => null);
      if (!bytes) {
        check(false, `${example.id} ${role}: ${was[role].name} was not written`);
        continue;
      }
      for (const [passed, line] of compareWithBrowser(`${example.id} ${role}`, summarize(was[role].name, bytes), was[role])) check(passed, line);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length
  ? `FAIL ${failures.length} degibbs command-line checks`
  : `PASS degibbs command line reproduces the web app's downloads on ${examples.length} example${examples.length === 1 ? '' : 's'}`);
process.exitCode = failures.length ? 1 : 0;

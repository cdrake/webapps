#!/usr/bin/env node
// Runs every command the web app offers on every pinned example with a niimath command line and
// compares each output with the web app's download, recorded in browser-reference.json by
// apps/niimath/e2e/reference.spec.js.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COMMANDS, EXAMPLE_SHA256, compareWithBrowser, downloadName, pinnedExamples, readReference, summarize } from './reference.mjs';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/niimath.js', import.meta.url))];

const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

const reference = await readReference();
check(JSON.stringify(reference.inputs) === JSON.stringify(EXAMPLE_SHA256), 'reference was recorded from the pinned example inputs');
check(JSON.stringify(reference.commands) === JSON.stringify(COMMANDS), `reference covers the web app's ${COMMANDS.length} commands`);

const examples = await pinnedExamples();
const work = await mkdtemp(join(tmpdir(), 'niimath-cli-check-'));
try {
  for (const example of examples) {
    for (const operations of COMMANDS) {
      const label = `${example.id} ${operations}`;
      const was = reference.browser.outputs[example.id]?.[operations];
      if (!was) {
        check(false, `${label}: reference holds the web app's download`);
        continue;
      }
      // An empty working directory, so no operation argument is mistaken for a file to read.
      const cwd = await mkdtemp(join(work, 'run-'));
      const output = join(cwd, downloadName(operations));
      const started = performance.now();
      const run = spawnSync(command[0], [...command.slice(1), example.path, ...operations.split(/\s+/), output], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (run.error) throw run.error;
      const seconds = (performance.now() - started) / 1000;
      if (run.status !== 0) {
        check(false, `${label}: exited with ${run.status}: ${run.stderr.slice(-2000)}`);
        continue;
      }
      check(run.stdout.trim() === output && JSON.stringify(await readdir(cwd)) === JSON.stringify([downloadName(operations)]), `${label}: writes only ${downloadName(operations)} and prints its path (${seconds.toFixed(1)} s)`);
      const provenance = JSON.parse(run.stderr.trim().split(/\r?\n/).at(-1));
      check(provenance.niimath === `${reference.browser.niimath} WebAssembly`, `${label}: runs ${provenance.niimath}, the build the browser reference was recorded with`);
      for (const [passed, line] of compareWithBrowser(label, summarize(await readFile(output)), was)) check(passed, line);
      await rm(cwd, { recursive: true, force: true });
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length
  ? `FAIL ${failures.length} niimath command-line checks`
  : `PASS niimath command line reproduces the web app's downloads for ${COMMANDS.length} commands on ${examples.length} examples`);
process.exitCode = failures.length ? 1 : 0;

#!/usr/bin/env node
// Runs a dicompare command line on the web app's example (apps/dicompare/examples.json) and holds
// every JSON report to browser-reference.json, recorded from the web app's own automation in
// Chromium by browser-reference.mjs. dicompare stamps each validation with the time it ran
// (analysis_timestamp); that value must be an ISO time and is otherwise excluded.
//
//   node packages/dicompare/validation/cli-check.mjs [--executable PATH]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CASES } from './cases.mjs';
import { exampleDirectory } from './example.mjs';

const reference = JSON.parse(await readFile(new URL('./browser-reference.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../python.manifest.json', import.meta.url), 'utf8'));
const pinned = { pyodide: manifest.pyodide, dicompare: /^dicompare-([^-]+)-/.exec(manifest.wheels.at(-1).name)[1] };
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/dicompare.js', import.meta.url))];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

function normalize(report) {
  return JSON.stringify(report, (key, value) => {
    if (key !== 'analysis_timestamp') return value;
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(value)) throw new Error(`analysis_timestamp ${value} is not an ISO time`);
    return '<analysis_timestamp>';
  }, 2);
}

function firstDifference(actual, expected) {
  let index = 0;
  while (index < actual.length && actual[index] === expected[index]) index += 1;
  return `at character ${index}: ${JSON.stringify(actual.slice(Math.max(0, index - 80), index + 80))} vs ${JSON.stringify(expected.slice(Math.max(0, index - 80), index + 80))}`;
}

const statuses = (report) => report.comparison.flatMap(({ results }) => results.map((result) => result.status));
const count = (list, status) => list.filter((value) => value === status).length;

const { directory } = await exampleDirectory(reference.example);
const work = await mkdtemp(join(tmpdir(), 'dicompare-cli-check-'));
try {
  const outputs = {};
  for (const { id, args } of CASES) {
    const output = join(work, id === 'build-schema' ? 'schema.json' : `${id}.json`);
    const argv = [...args.map((arg) => arg.replace(/^\{(.+)\}$/, (_, name) => outputs[name])), directory, '--output', output];
    const started = performance.now();
    const run = spawnSync(command[0], [...command.slice(1), ...argv], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${command.join(' ')} ${argv.join(' ')} exited with ${run.status}:\n${run.stderr}`);
    outputs[id] = output;
    const summary = JSON.parse(run.stderr.trim().split('\n').at(-1));
    console.log(`INFO ${id}: ${JSON.stringify(summary)} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
    check(summary.dicompare === pinned.dicompare && summary.pyodide === pinned.pyodide, `${id} ran dicompare ${summary.dicompare} in Pyodide ${summary.pyodide}`);

    const bytes = await readFile(output, 'utf8');
    const expected = reference.reports[id];
    const actual = normalize(JSON.parse(bytes));
    const wanted = normalize(expected.report);
    check(bytes === JSON.stringify(JSON.parse(bytes), null, 2), `${id} report is serialized as the app serializes it`);
    check(actual === wanted, actual === wanted
      ? `${id} report equals the ${expected.source} (${sha256(actual).slice(0, 12)})`
      : `${id} report differs from the ${expected.source} ${firstDifference(actual, wanted)}`);
  }
  const library = statuses(JSON.parse(await readFile(outputs['compare-library'], 'utf8')));
  console.log(`INFO compare-library: ${count(library, 'pass')} pass, ${count(library, 'fail')} fail, ${count(library, 'warning')} warning`);
  const self = statuses(JSON.parse(await readFile(outputs['compare-built-schema'], 'utf8')));
  check(self.length > 0 && self.every((status) => status === 'pass'), `the example passes all ${self.length} checks of the schema built from it`);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} dicompare command-line checks` : 'PASS dicompare command line matches the web app on its example');
process.exitCode = failures.length ? 1 : 0;

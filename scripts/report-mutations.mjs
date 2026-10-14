#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { modules, smoke as smokeTarget } from '../stryker.config.mjs';

const output = 'quality-artifacts/mutations';

function countStatuses(file, mutants) {
  if (!mutants.length) throw new Error(`No mutations were tested in ${file}`);
  const counts = { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0, Ignored: 0 };
  for (const mutant of mutants) {
    if (!(mutant.status in counts)) throw new Error(`Invalid mutant status: ${mutant.status}`);
    counts[mutant.status]++;
  }
  if (counts.RuntimeError) throw new Error(`Stryker reported test runner runtime errors in ${file}`);
  const assessed = counts.Killed + counts.Timeout + counts.Survived + counts.NoCoverage;
  if (!assessed) throw new Error(`No mutations completed successfully in ${file}`);
  return { ...counts, assessed, score: (100 * (counts.Killed + counts.Timeout) / assessed).toFixed(2) };
}

export function summarizeMutations(report, { smoke = false, expected = smoke ? [smokeTarget.file] : modules.map((module) => module.file) } = {}) {
  if (!report || !report.files || typeof report.files !== 'object') {
    throw new Error('Stryker did not produce a mutation report');
  }
  const files = Object.entries(report.files);
  const names = files.map(([file]) => file).sort();
  if (names.join('\n') !== [...expected].sort().join('\n') || files.some(([, file]) => !Array.isArray(file.mutants))) {
    throw new Error(`Mutation report must contain exactly the configured modules: ${expected.join(', ')}`);
  }
  const results = files.map(([file, { mutants }]) => ({ file, mutants, counts: countStatuses(file, mutants) }));
  if (smoke && !results.some(({ counts }) => counts.Killed)) throw new Error('Smoke canary did not detect any mutation');
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'");
  const totals = results.map(({ file, counts }) => `| ${file} | ${counts.score}% | ${counts.assessed} | ${counts.Killed} | ${counts.Survived} | ${counts.NoCoverage} | ${counts.Timeout} | ${counts.CompileError} | ${counts.Ignored} |`);
  const survivors = results.flatMap(({ file, mutants }) => mutants
    .filter((mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage')
    .map((mutant) => `| ${file} | ${mutant.location.start.line} | ${mutant.mutatorName} | ${escape(mutant.replacement)} |`));
  return `## Mutation testing${smoke ? ' smoke' : ''}\n\n| Module | Score | Assessed | Killed | Survived | Uncovered | Timed out | Compile errors | Ignored |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${totals.join('\n')}\n\nScores are report-only. Configuration, baseline test and tool failures fail the job. The smoke canary must detect at least one mutation.\n\n${survivors.length ? `| Module | Line | Mutator | Surviving replacement |\n| --- | --- | --- | --- |\n${survivors.join('\n')}\n\n` : 'No surviving mutants in this run.\n\n'}docs/quality/mutation-testing.md explains the reviewed survivors. The mutation-quality artifact contains the JSON report, HTML report and tool log.\n`;
}

export function runMutations({ cwd = process.cwd(), smoke = false, config = 'stryker.config.mjs', executable = process.execPath, prefix = [fileURLToPath(new URL('../node_modules/@stryker-mutator/core/bin/stryker.js', import.meta.url))], summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const artifacts = resolve(cwd, output);
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  const args = [...prefix, 'run', config];
  // A small, stable naming function provides the PR mutation-detection canary.
  if (smoke) args.push('--mutate', smokeTarget.mutate);
  const env = { ...process.env };
  // Nested node:test processes must execute their suites independently.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(resolve(artifacts, 'stryker.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Stryker failed with ${result.signal ?? `exit ${result.status}`}`);
  const report = JSON.parse(readFileSync(resolve(artifacts, 'mutation.json'), 'utf8'));
  const markdown = summarizeMutations(report, { smoke });
  writeFileSync(resolve(artifacts, 'summary.md'), markdown);
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { smoke: { type: 'boolean', default: false }, config: { type: 'string', default: 'stryker.config.mjs' } } });
  try {
    runMutations(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

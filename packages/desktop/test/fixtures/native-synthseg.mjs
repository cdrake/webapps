#!/usr/bin/env node
import { readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const input = args[args.indexOf('--i') + 1];
const output = args[args.indexOf('--o') + 1];
const fixture = JSON.parse(await readFile(input, 'utf8'));
if (fixture.mode === 'hang') process.on('SIGTERM', () => {});
await writeFile(`${input}.argv.json`, JSON.stringify(args));
if (fixture.mode === 'hang') {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (fixture.mode === 'fail') {
  process.stdout.write('output noise'.repeat(20000));
  process.stderr.write(`${'x'.repeat(100000)}\nfixture inference error\n`);
  process.exitCode = 7;
} else if (fixture.mode !== 'missing') {
  if (fixture.mode === 'symlink') await symlink(input, output);
  else await writeFile(output, fixture.mode === 'empty' ? '' : gzipSync(Buffer.from(fixture.labels, 'base64')));
  const provenance = {
    package: 'synthseg',
    version: 'fixture-build-4',
    model: 'Fixture model',
    modelSha256: 'a'.repeat(64),
    executionProvider: 'metal',
    ct: args.includes('--ct'),
    fast: args.includes('--fast'),
    input: await realpath(input),
    output,
    outputShape: [2, 2, 2],
    seconds: 0.01,
  };
  if (fixture.mode === 'wrong-parameters') provenance.ct = !provenance.ct;
  if (fixture.mode === 'missing-backend') delete provenance.executionProvider;
  const sidecar = output.replace(/\.nii\.gz$/, '.json');
  if (fixture.mode === 'symlink-report') await symlink(input, sidecar);
  else await writeFile(sidecar, fixture.mode === 'invalid-json' ? '{broken' : JSON.stringify(provenance));
}

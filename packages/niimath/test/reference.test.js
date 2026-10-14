import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { COMMANDS, compareWithBrowser, downloadName, readReference, summarize } from '../validation/reference.mjs';
import { outputKind } from '../src/node.js';

const app = (path) => readFile(new URL(`../../../apps/niimath/${path}`, import.meta.url), 'utf8');

test('the release check covers every command the web app offers', async () => {
  const automation = JSON.parse(await app('automation.json'));
  const field = /id="command"[^>]*value="([^"]+)"/.exec(await app('index.html'))[1];
  const menu = /function populateMoreCommands\(\) \{[\s\S]*?const commands = \[([\s\S]*?)\];/.exec(await app('main.js'))[1];
  const offered = [automation.operations.process.parameters.command.default, field, ...[...menu.matchAll(/'([^']+)'/g)].map((match) => match[1])];
  assert.deepEqual([...COMMANDS], offered);
  assert.deepEqual((await readReference()).commands, [...COMMANDS], 'browser-reference.json was recorded for these commands');
});

test('the command line stages its output under the web app\'s download name', () => {
  for (const command of COMMANDS) assert.equal(outputKind(command.split(/\s+/)).staged, downloadName(command), command);
});

test('a download passes only when its bytes equal the browser\'s', () => {
  const failed = (is, was) => compareWithBrowser('cli', is, was).filter(([passed]) => !passed).map(([, line]) => line);
  const image = gzipSync(Buffer.from('voxels'));
  const reference = summarize(image);
  assert.deepEqual(failed(summarize(image), reference), []);
  const recompressed = summarize(gzipSync(Buffer.from('voxels'), { level: 1 }));
  assert.equal(failed(recompressed, reference).length, 1, 'other compression of the same image fails on the file bytes only');
  assert.equal(failed(summarize(gzipSync(Buffer.from('voxelz'))), reference).length, 2);
  const png = Buffer.from('png');
  assert.deepEqual(failed(summarize(png), summarize(png)), []);
  assert.equal(failed(summarize(Buffer.from('pnh')), summarize(png)).length, 1);
});

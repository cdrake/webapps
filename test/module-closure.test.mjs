import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commandLineClosure } from '../scripts/lib/module-closure.mjs';

test('workspace export remapping keeps the transitive manifest in the command-line inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-closure-'));
  try {
    await mkdir(join(root, 'exes'));
    await mkdir(join(root, 'packages/cli'), { recursive: true });
    await mkdir(join(root, 'packages/dependency/src'), { recursive: true });
    await writeFile(join(root, 'packages/cli/package.json'), JSON.stringify({ name: '@fixture/cli', bin: './cli.js' }));
    await writeFile(join(root, 'packages/cli/cli.js'), 'import "@fixture/dependency";\n');
    await writeFile(join(root, 'packages/dependency/src/first.js'), 'export const method = "first";\n');
    await writeFile(join(root, 'packages/dependency/src/second.js'), 'export const method = "second";\n');
    for (const target of ['first', 'second']) {
      await writeFile(join(root, 'packages/dependency/package.json'), JSON.stringify({ name: '@fixture/dependency', type: 'module', exports: `./src/${target}.js` }));
      assert.deepEqual(commandLineClosure(root, 'packages/cli'), [
        'packages/dependency/package.json',
        `packages/dependency/src/${target}.js`,
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

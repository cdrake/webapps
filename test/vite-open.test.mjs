import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

// `vite preview` inherits server.open, so a smoke or e2e run would open a tab in
// the developer's default browser.
test('no app config opens a browser', async () => {
  const registry = await loadAppsRegistry();
  const found = [];
  for (const { id } of registry.apps) {
    const root = join(repoRoot, 'apps', id);
    for (const directory of [root, join(root, 'web')]) {
      const names = await readdir(directory).catch(() => []);
      for (const name of names.filter((entry) => /^vite\.config\.[cm]?[jt]s$/.test(entry))) {
        const text = await readFile(join(directory, name), 'utf8');
        if (/\bopen\s*:/.test(text)) found.push(join('apps', id, directory === root ? '' : 'web', name));
      }
    }
  }
  assert.deepEqual(found, []);
});

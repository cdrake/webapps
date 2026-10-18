import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import parser from '@neurodesk/code-quality';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

function opensBrowser(source) {
  const { ast, visitorKeys } = parser.parseForESLint(source, { sourceType: 'module' });
  function visit(node) {
    if (!node) return false;
    if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'open'
        && !(node.value.type === 'Literal' && node.value.value === false)) return true;
    return (visitorKeys[node.type] ?? []).some(key => {
      const children = Array.isArray(node[key]) ? node[key] : [node[key]];
      return children.some(visit);
    });
  }
  return visit(ast);
}

for (const [name, source, expected] of [
  ['unquoted true', 'export default { server: { open: true } };', true],
  ['single-quoted true', "export default { server: { 'open': true } };", true],
  ['double-quoted path', 'export default { preview: { "open": "/index.html" } };', true],
  ['unquoted false', 'export default { server: { open: false } };', false],
  ['quoted false', 'export default { server: { "open": false } };', false],
  ['TypeScript config', 'const port: number = 3000; export default { server: { port, "open": true } };', true],
  ['comments', '// server: { open: true }\nexport default { /* "open": true */ };', false],
  ['string content', 'const help = "server: { open: true }"; export default {};', false],
]) {
  test(`browser-open guard handles ${name}`, () => {
    assert.equal(opensBrowser(source), expected);
  });
}

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
        if (opensBrowser(text)) found.push(join('apps', id, directory === root ? '' : 'web', name));
      }
    }
  }
  assert.deepEqual(found, []);
});

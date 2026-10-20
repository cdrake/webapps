import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The files a workspace package's command line and Node entry points load,
// outside the package itself: static and literal dynamic imports, followed
// through relative paths and workspace packages' `exports`. Native and CLI
// workflows filter on these so that a change to a dependency runs them.
// It is a lower bound: computed specifiers and non-import reads are not seen.

// Imports, plus files loaded through `new URL('./file', import.meta.url)`:
// workers, WebAssembly and data next to the module.
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|new\s+URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
// Entry points a command line or its Node API starts from, besides `bin`.
const NODE_ENTRIES = ['./node', '.'];
const SOURCE_ENTRIES = ['src/node.js', 'src/index.js'];

function workspacePackages(root) {
  const packages = new Map();
  for (const top of ['packages', 'exes']) {
    for (const name of readdirSync(join(root, top))) {
      const manifest = join(root, top, name, 'package.json');
      if (existsSync(manifest)) packages.set(JSON.parse(readFileSync(manifest, 'utf8')).name, join(root, top, name));
    }
  }
  return packages;
}

const exportTarget = (value) => (typeof value === 'string' ? value : value?.import ?? value?.node ?? value?.default);

function exportsOf(manifest) {
  if (typeof manifest.exports === 'string') return { '.': manifest.exports };
  return manifest.exports ?? { '.': manifest.main ?? './index.js' };
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();

function resolveSpecifier(packages, specifier, from) {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(from), specifier);
    return [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')].find(isFile) ?? null;
  }
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  const dir = packages.get(name);
  if (!dir) return null;
  const exports = exportsOf(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
  const subpath = `.${specifier.slice(name.length)}`;
  let target = exportTarget(exports[subpath]);
  for (const [key, value] of Object.entries(exports)) {
    if (!target && key.endsWith('*') && subpath.startsWith(key.slice(0, -1))) {
      target = exportTarget(value)?.replace('*', subpath.slice(key.length - 1));
    }
  }
  return target && isFile(join(dir, target)) ? join(dir, target) : null;
}

export function commandLineClosure(root, packageDir) {
  const directory = join(root, packageDir);
  const packages = workspacePackages(root);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const exports = exportsOf(manifest);
  const pending = [...bins, ...NODE_ENTRIES.map((key) => exportTarget(exports[key])), ...SOURCE_ENTRIES]
    .filter(Boolean)
    .map((file) => join(directory, file))
    .filter(isFile);
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?js$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const next = resolveSpecifier(packages, match[1] ?? match[2] ?? match[3] ?? match[4], file);
      if (next && !seen.has(next)) pending.push(next);
    }
  }
  return [...seen]
    .map((file) => relative(root, file).split('\\').join('/'))
    .filter((file) => !file.startsWith(`${packageDir}/`))
    .sort();
}

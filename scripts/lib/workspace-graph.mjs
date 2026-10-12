import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Which apps/, packages/ and exes/ directories each workspace directory uses.
// Declared workspace dependencies are not enough: apps also reach shared code
// through relative paths in build scripts, Vite configs and Rust `#[path]`
// includes, so text references count as edges too. Root scripts an app runs
// (`../../scripts/theme-app-dist.mjs`) are nodes of their own, followed
// through their relative imports to the packages they copy or bundle. A false
// reference only widens the CI selection.

const TOP_LEVEL = ['apps', 'packages', 'exes'];
// Apps are leaves: a package that mentions an app does not use what that app uses.
const SHARED_LEVEL = new Set(['packages', 'exes']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'target', '.turbo', '.vite', 'coverage', 'test-results', 'playwright-report']);
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html|css|rs|toml|py|sh|ya?ml)$|^Makefile$/;
const MAX_TEXT_BYTES = 1024 * 1024;
const REFERENCE = /(?:\.\.\/)+(packages|exes)\/([\w.-]+)/g;
// Scripts address packages from the repository root, in either form.
const SCRIPT_REFERENCE = /\b(packages|exes)(?:\/|['"],\s*['"])([\w.-]+)/g;
const SCRIPT_PATH = /(?:\.\.\/)+(scripts\/[\w./-]+\.[cm]?js)\b/g;
const SCRIPT_IMPORT = /['"](\.\.?\/[^'"\s]+\.[cm]?js)['"]/g;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

async function listDirs(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function* textFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* textFiles(join(dir, entry.name));
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

async function readPackageJson(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function nodeOf(root, path) {
  const [top, name] = relative(root, path).split(/[\\/]/);
  return SHARED_LEVEL.has(top) && name ? `${top}/${name}` : null;
}

export async function loadWorkspaceGraph(root) {
  const nodes = (await Promise.all(TOP_LEVEL.map(async (top) => (await listDirs(join(root, top))).map((name) => `${top}/${name}`)))).flat();
  const nodeSet = new Set(nodes);
  const manifests = new Map(await Promise.all(nodes.map(async (node) => [node, await readPackageJson(join(root, node))])));
  const nodeByPackageName = new Map([...manifests].filter(([, manifest]) => manifest?.name).map(([node, manifest]) => [manifest.name, node]));

  const edges = new Map();
  const pendingScripts = [];
  for (const node of nodes) {
    const uses = new Set();
    const manifest = manifests.get(node);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
        const workspaceNode = String(spec).startsWith('workspace:') && nodeByPackageName.get(name);
        if (workspaceNode && SHARED_LEVEL.has(workspaceNode.split('/')[0])) uses.add(workspaceNode);
        if (String(spec).startsWith('file:')) {
          const target = nodeOf(root, resolve(root, node, String(spec).slice('file:'.length)));
          if (target) uses.add(target);
        }
      }
    }
    for await (const file of textFiles(join(root, node))) {
      if ((await stat(file)).size > MAX_TEXT_BYTES) continue;
      const text = await readFile(file, 'utf8');
      for (const [, top, name] of text.matchAll(REFERENCE)) {
        if (nodeSet.has(`${top}/${name}`)) uses.add(`${top}/${name}`);
      }
      for (const [, script] of text.matchAll(SCRIPT_PATH)) {
        uses.add(script);
        pendingScripts.push(script);
      }
    }
    uses.delete(node);
    edges.set(node, uses);
  }

  while (pendingScripts.length) {
    const script = pendingScripts.pop();
    if (edges.has(script)) continue;
    const uses = new Set();
    edges.set(script, uses);
    const text = await readFile(join(root, script), 'utf8').catch(() => null);
    if (text === null) continue;
    for (const [, top, name] of text.matchAll(SCRIPT_REFERENCE)) {
      if (nodeSet.has(`${top}/${name}`)) uses.add(`${top}/${name}`);
    }
    for (const [, path] of text.matchAll(SCRIPT_IMPORT)) {
      const imported = relative(root, resolve(root, dirname(script), path)).split(sep).join('/');
      if (imported.startsWith('scripts/')) {
        uses.add(imported);
        pendingScripts.push(imported);
      }
    }
  }
  return Object.freeze({ nodes: Object.freeze(nodes), edges });
}

// Every directory or root script `node` uses, directly or through others.
export function reachableFrom(graph, node) {
  const seen = new Set([node]);
  const pending = [node];
  while (pending.length) {
    for (const next of graph.edges.get(pending.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return seen;
}

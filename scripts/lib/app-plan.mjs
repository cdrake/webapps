import { execFileSync } from 'node:child_process';
import { CATALOG, SITE, reachableFrom } from './workspace-graph.mjs';

const NON_CODE_PREFIXES = ['docs/', '.changeset/'];
// Self-contained packages outside apps/ with their own CI job (the homepage
// easter egg and its leaderboard worker run under `homepage-easter-egg`).
// Changes there select no catalog apps. Shared homepage files directly under
// site/ still count as shared changes.
const SELF_CONTAINED_PREFIXES = ['site/easter-eggs/'];
// Paths no app build or browser test reads. Lint and quality tooling run in
// workspace-contracts or their own workflows; every workflow other than ci.yml
// runs itself when it changes; the app template is checked by contract tests.
const INDEPENDENT_CHECK_PATHS = [
  /^[^/]+\.md$/,
  /^\.gitignore$/,
  /^\.github\/workflows\/(?!ci\.yml$)[^/]+$/,
  /^(?:eslint|knip|stryker)\.config\.m?js$/,
  /^config\/dependency-/,
  /^templates\//,
];
// Root files the workspace graph follows. Without a graph they count as shared.
const ROOT_FILE = /^(?:scripts|test-utils|registry|test)\//;
// An app's model manifest belongs to that app alone.
const MODEL_MANIFEST = /^models\/([^/]+)\.manifest\.json$/;
const NON_CODE_FILES = new Set([
  'README.md',
  'LICENSES.md',
  // App additions and dependency changes update these shared manifests, but
  // the corresponding apps/<id>/ paths already identify the unit-test scope.
  'pnpm-lock.yaml',
  'registry/apps.yml',
]);

function shardedEntries(app) {
  const total = app.ci.e2e_shards ?? 1;
  return Array.from({ length: total }, (_, index) => ({ ...matrixEntry(app), shard: total > 1 ? `${index + 1}/${total}` : '' }));
}

function matrixEntry(app) {
  const toolchains = new Set(app.ci.toolchains);
  return {
    app: app.id,
    path: app.path,
    runtime: app.runtime,
    rust_wasm: toolchains.has('rust-wasm'),
    python_reference: toolchains.has('python-reference'),
    shared_runtime: app.ci.shared_runtime,
    browser_test: app.ci.browser_test,
    hardware_gpu: app.ci.hardware_gpu,
    app_scoped_runtime: app.app_scoped_runtime_families.length > 0,
    release_test: app.ci.release_test ?? 'test',
  };
}

const OFFLINE_LOCK = 'registry/offline-assets.lock.json';

// The apps whose locked assets or asset lists a lock change touched. Per-app
// jobs read the lock only to check their own app's pinned examples.
function lockOwners({ before, after }) {
  const [old, now] = [JSON.parse(before), JSON.parse(after)];
  const urls = new Set([...Object.keys(old.assets), ...Object.keys(now.assets)]);
  const changed = new Set([...urls].filter((url) => JSON.stringify(old.assets[url]) !== JSON.stringify(now.assets[url])));
  const apps = new Set([...Object.keys(old.apps), ...Object.keys(now.apps)]);
  return [...apps].filter((app) => JSON.stringify(old.apps[app]) !== JSON.stringify(now.apps[app]) || [...(old.apps[app] ?? []), ...(now.apps[app] ?? [])].some((url) => changed.has(url)));
}

// The top-level fields a package.json change touched.
function changedFields({ before, after }) {
  const [old, now] = [JSON.parse(before), JSON.parse(after)];
  const fields = new Set([...Object.keys(old), ...Object.keys(now)]);
  return [...fields].filter((field) => JSON.stringify(old[field]) !== JSON.stringify(now[field]));
}

// Which root package.json scripts changed, or null when anything else changed.
function changedRootScripts(manifest) {
  if (changedFields(manifest).some((field) => field !== 'scripts')) return null;
  const [old, now] = [JSON.parse(manifest.before).scripts ?? {}, JSON.parse(manifest.after).scripts ?? {}];
  return [...new Set([...Object.keys(old), ...Object.keys(now)])].filter((name) => old[name] !== now[name]);
}

// The apps a change tests, and whether it needs the composite site build.
// Without a workspace graph every packages/, exes/ or root file change counts
// as shared. With one, a change selects the apps that reach it; a root file
// that ci.yml's per-app jobs run selects every app, and one only the
// composite-site job runs selects no app but the site build. `manifests` maps
// a changed package.json or offline asset lock to its text before and after:
// root script edits count only where ci.yml runs them, and a lock change
// selects the apps whose assets changed. Markdown in a package or exes/
// directory reaches only the apps that read that exact file.
export function selectAffectedApps(registry, changedPaths = [], graph = null, manifests = new Map()) {
  if (!changedPaths.length) return { apps: registry.apps, site: true };

  const appIds = new Set(registry.apps.map((app) => app.id));
  const reach = graph && new Map(registry.apps.map((app) => [app.id, reachableFrom(graph, `apps/${app.id}`)]));
  const catalog = graph && reachableFrom(graph, CATALOG);
  const site = graph && reachableFrom(graph, SITE);
  const directlyChanged = new Set();
  let sharedChange = false;
  let siteChange = false;

  for (const path of changedPaths) {
    const appId = path.match(/^apps\/([^/]+)\//)?.[1] ?? path.match(MODEL_MANIFEST)?.[1];
    if (appIds.has(appId)) {
      directlyChanged.add(appId);
      continue;
    }
    if (
      NON_CODE_FILES.has(path) ||
      NON_CODE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      SELF_CONTAINED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      INDEPENDENT_CHECK_PATHS.some((pattern) => pattern.test(path))
    ) {
      continue;
    }
    const manifest = graph && manifests.get(path);
    if (manifest && path === 'package.json') {
      const scripts = changedRootScripts(manifest);
      if (scripts) {
        sharedChange ||= scripts.some((name) => graph.rootScriptsRun.get(CATALOG).has(name));
        siteChange ||= scripts.some((name) => graph.rootScriptsRun.get(SITE).has(name));
        continue;
      }
    }
    if (manifest && path === OFFLINE_LOCK) {
      for (const app of lockOwners(manifest)) if (appIds.has(app)) directlyChanged.add(app);
      siteChange = true;
      continue;
    }
    // A package's tests reach only the apps that read them; any other file
    // reaches its package's users and, if a root file names it, that file's.
    const packageTests = path.match(/^packages\/[^/]+\/tests?(?=\/)/)?.[0];
    const document = /^(?:packages|exes)\/.*\.md$/.test(path) && path;
    const nodes = packageTests || document
      ? [packageTests || document]
      : [path.match(/^(packages|exes)\/[^/]+(?=\/)/)?.[0], ROOT_FILE.test(path) || graph?.edges.has(path) ? path : null].filter(Boolean);
    if (graph && nodes.length) {
      // Per-app jobs name packages only to provision their own app's data.
      if (ROOT_FILE.test(path) && catalog.has(path)) {
        sharedChange = true;
        continue;
      }
      siteChange ||= nodes.some((node) => site.has(node));
      for (const candidate of registry.apps) {
        if (nodes.some((node) => reach.get(candidate.id).has(node))) directlyChanged.add(candidate.id);
      }
      continue;
    }
    sharedChange = true;
  }

  if (sharedChange) return { apps: registry.apps, site: true };
  if (directlyChanged.has('qsmbly')) directlyChanged.add('brain-extraction');
  return { apps: registry.apps.filter((app) => directlyChanged.has(app.id)), site: siteChange };
}

export function createAppPlan(registry, changedPaths = [], graph = null, manifests = new Map()) {
  const { apps: selected, site } = selectAffectedApps(registry, changedPaths, graph, manifests);
  const releasable = selected.filter((app) => app.ci.release);
  const browserTested = selected.filter((app) => app.ci.browser_test);
  const gpuTested = selected.filter((app) => app.ci.hardware_gpu);
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    selected: Object.freeze(selected),
    apps: Object.freeze({ include: Object.freeze(selected.map(matrixEntry)) }),
    browserApps: Object.freeze({ include: Object.freeze(browserTested.flatMap(shardedEntries)) }),
    gpuApps: Object.freeze({ include: Object.freeze(gpuTested.map(matrixEntry)) }),
    releaseApps: Object.freeze({ include: Object.freeze(releasable.map(matrixEntry)) }),
    allApps: selected.length === registry.apps.length,
    site: site || selected.length > 0,
  });
}

export function changedPathsFromGit({ base, head = 'HEAD', cwd }) {
  if (!base || /^0+$/.test(base)) return [];
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

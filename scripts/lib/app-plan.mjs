import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { reachableFrom } from './workspace-graph.mjs';

const NON_CODE_PREFIXES = ['docs/', '.changeset/'];
// Self-contained packages outside apps/ with their own CI job (the homepage
// easter egg and its leaderboard worker run under `homepage-easter-egg`).
// Changes there select no catalog apps. Shared homepage files directly under
// site/ still count as shared changes.
const SELF_CONTAINED_PREFIXES = ['site/easter-eggs/'];
// Root tests that `test:contracts` leaves out run only beside an app build.
const contractsScript = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts['test:contracts'];
const OUTSIDE_CONTRACTS = new Set([...contractsScript.matchAll(/-e \/([\w.-]+\.test\.mjs)/g)].map(([, name]) => `test/${name}`));

// Paths no app build or browser test reads. Root contract tests, lint and
// quality tooling run in workspace-contracts or their own workflows; desktop
// scripts run in the standalone workflow; every workflow other than ci.yml
// runs itself when it changes; the app template is checked by contract tests.
const NON_APP_PATHS = [
  /^[^/]+\.md$/,
  /^\.gitignore$/,
  /^test\/[^/]+\.test\.mjs$/,
  /^\.github\/workflows\/(?!ci\.yml$)[^/]+$/,
  /^scripts\/(?:desktop|quality)\//,
  /^scripts\/(?:lint|lint-workspaces|report-unused-code|report-mutations|check-dependencies)\.mjs$/,
  /^(?:eslint|knip|stryker)\.config\.m?js$/,
  /^config\/dependency-/,
  /^templates\//,
];
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

// Without a workspace graph every packages/ or exes/ change counts as shared.
export function selectAffectedApps(registry, changedPaths = [], graph = null) {
  if (!changedPaths.length) return registry.apps;

  const appIds = new Set(registry.apps.map((app) => app.id));
  const reach = graph && new Map(registry.apps.map((app) => [app.id, reachableFrom(graph, `apps/${app.id}`)]));
  const directlyChanged = new Set();
  let sharedChange = false;

  for (const path of changedPaths) {
    const appId = path.match(/^apps\/([^/]+)\//)?.[1] ?? path.match(MODEL_MANIFEST)?.[1];
    if (appIds.has(appId)) {
      directlyChanged.add(appId);
      continue;
    }
    const workspaceNode = path.match(/^(packages|exes)\/[^/]+(?=\/)/)?.[0];
    if (reach && graph.edges.has(workspaceNode)) {
      for (const candidate of registry.apps) {
        if (reach.get(candidate.id).has(workspaceNode)) directlyChanged.add(candidate.id);
      }
      continue;
    }
    if (
      NON_CODE_FILES.has(path) ||
      NON_CODE_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      SELF_CONTAINED_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      (NON_APP_PATHS.some((pattern) => pattern.test(path)) && !OUTSIDE_CONTRACTS.has(path))
    ) {
      continue;
    }
    sharedChange = true;
  }

  if (sharedChange) return registry.apps;
  if (directlyChanged.size === 0) return [];
  if (directlyChanged.has('qsmbly')) directlyChanged.add('brain-extraction');
  return registry.apps.filter((app) => directlyChanged.has(app.id));
}

export function createAppPlan(registry, changedPaths = [], graph = null) {
  const selected = selectAffectedApps(registry, changedPaths, graph);
  const releasable = selected.filter((app) => app.ci.release);
  const browserTested = selected.filter((app) => app.ci.browser_test);
  const gpuTested = selected.filter((app) => app.ci.hardware_gpu);
  return Object.freeze({
    changedPaths: Object.freeze([...changedPaths]),
    selected: Object.freeze(selected),
    apps: Object.freeze({ include: Object.freeze(selected.map(matrixEntry)) }),
    browserApps: Object.freeze({ include: Object.freeze(browserTested.map(matrixEntry)) }),
    gpuApps: Object.freeze({ include: Object.freeze(gpuTested.map(matrixEntry)) }),
    releaseApps: Object.freeze({ include: Object.freeze(releasable.map(matrixEntry)) }),
    allApps: selected.length === registry.apps.length,
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

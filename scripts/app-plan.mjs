#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createAppPlan, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { loadWorkspaceGraph, WorkspaceGraphConfigurationError } from './lib/workspace-graph.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const registry = await loadAppsRegistry();
let changedPaths = process.argv.includes('--all')
  ? []
  : changedPathsFromGit({ base: option('--base'), head: option('--head') || 'HEAD', cwd: repoRoot });
const only = option('--only');
if (only && only !== 'affected') {
  const ids = new Set(only.split(',').map((id) => id.trim()).filter(Boolean));
  const unknown = [...ids].filter((id) => !registry.apps.some((app) => app.id === id));
  if (unknown.length) throw new Error(`Unknown app ids: ${unknown.join(', ')}`);
  changedPaths = [...ids].map((id) => `apps/${id}/package.json`);
}
// changedPathsFromGit diffs from the merge base, so manifests are compared there too.
const head = option('--head') || 'HEAD';
const manifestPaths = changedPaths.filter((path) => /^(?:(?:packages|apps|exes)\/[^/]+\/)?package\.json$|^registry\/offline-assets\.lock\.json$/.test(path));
const base = option('--base');
let mergeBase;
if (manifestPaths.length && base && !/^0+$/.test(base)) {
  try {
    mergeBase = execFileSync('git', ['merge-base', base, head], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Explicit --only selections do not require history. Without it, keep
    // treating their manifests as code changes instead of refining the scope.
  }
}
const show = (revision, path) => execFileSync('git', ['show', `${revision}:${path}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const manifests = new Map();
for (const path of mergeBase ? manifestPaths : []) {
  try {
    manifests.set(path, { before: show(mergeBase, path), after: show(head, path) });
  } catch {
    // An added or deleted manifest is a code change like any other.
  }
}
let graph;
let fallbackReason = '';
try {
  graph = await loadWorkspaceGraph(repoRoot);
} catch (error) {
  if (!(error instanceof WorkspaceGraphConfigurationError)) throw error;
  fallbackReason = error.message;
  console.error(`App planner: selecting the full catalog and site because ${fallbackReason}`);
}
const plan = createAppPlan(registry, fallbackReason ? [] : changedPaths, graph, manifests);
const emptyMatrix = { include: [{ app: '__none__', path: '', runtime: '', rust_wasm: false, python_reference: false, shared_runtime: false, browser_test: false, hardware_gpu: false, app_scoped_runtime: false, release_test: 'test' }] };
const outputs = {
  apps: JSON.stringify(plan.apps.include.length ? plan.apps : emptyMatrix),
  browser_apps: JSON.stringify(plan.browserApps.include.length ? plan.browserApps : emptyMatrix),
  gpu_apps: JSON.stringify(plan.gpuApps.include.length ? plan.gpuApps : emptyMatrix),
  release_apps: JSON.stringify(plan.releaseApps.include.length ? plan.releaseApps : emptyMatrix),
  selected_ids: JSON.stringify(plan.selected.map((app) => app.id)),
  has_apps: String(plan.apps.include.length > 0),
  has_browser_apps: String(plan.browserApps.include.length > 0),
  has_gpu_apps: String(plan.gpuApps.include.length > 0),
  has_release_apps: String(plan.releaseApps.include.length > 0),
  all_apps: String(plan.allApps),
  has_site: String(plan.site),
  fallback_reason: fallbackReason,
};

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
  );
} else {
  console.log(JSON.stringify({ changedPaths, ...outputs }, null, 2));
}

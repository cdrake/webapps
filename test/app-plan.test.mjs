import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { CATALOG_JOBS, loadWorkspaceGraph, WorkspaceGraphConfigurationError } from '../scripts/lib/workspace-graph.mjs';

const graph = loadWorkspaceGraph(repoRoot);

test('app-local changes select only that webapp', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/niimath/main.js']);
  assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']);
  assert.deepEqual(plan.browserApps.include.map(({ app }) => app), ['niimath']);
});

test('QSMbly runtime changes also select Brain extraction for browser tests and release', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/qsmbly/rust-wasm/src/lib.rs']);
  assert.deepEqual(plan.selected.map(app => app.id), ['qsmbly', 'brain-extraction']);
  assert.ok(plan.browserApps.include.some(({ app }) => app === 'brain-extraction'));
  assert.ok(plan.releaseApps.include.some(({ app }) => app === 'brain-extraction'));
});

test('app registration and lockfile updates stay scoped to that webapp', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, [
    'LICENSES.md',
    'apps/surfannotate/package.json',
    'pnpm-lock.yaml',
    'registry/apps.yml',
  ]);
  assert.deepEqual(plan.selected.map((app) => app.id), ['surfannotate']);
  assert.deepEqual(plan.browserApps.include.map(({ app }) => app), ['surfannotate']);
  assert.equal(plan.allApps, false);
});

test('homepage easter-egg changes select no catalog apps', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, [
    'site/easter-eggs/vessel-surfer/src/main.js',
    'site/easter-eggs/vessel-surfer-leaderboard/src/worker.js',
    'site/easter-eggs/vessel-surfer/package.json',
    '.changeset/vessel-surfer-tracks.md',
  ]);
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.browserApps.include, []);
  assert.equal(plan.allApps, false);
});

test('shared homepage files still select the complete app catalog', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['site/landing.js', 'site/app-theme.css', 'scripts/lib/landing-page.mjs']) {
    const plan = createAppPlan(registry, [path]);
    assert.equal(plan.selected.length, registry.apps.length, path);
  }
});

test('shared module changes select the complete app catalog', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/components/src/ui/ProgressManager.js']);
  assert.equal(plan.selected.length, registry.apps.length);
  assert.deepEqual(
    plan.browserApps.include.map(({ app }) => app),
    registry.apps.filter((app) => app.ci.browser_test).map((app) => app.id),
  );
  assert.deepEqual(
    plan.gpuApps.include.map(({ app }) => app),
    registry.apps.filter((app) => app.ci.hardware_gpu).map((app) => app.id),
  );
});

test('an app change selects the macOS GPU job only for hardware-GPU apps', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['apps/brain2print/src/main.js']).gpuApps.include.map(({ app }) => app), ['brain2print']);
  assert.deepEqual(createAppPlan(registry, ['apps/niimath/index.html']).gpuApps.include, []);
});

test('toolchain facts are carried into generated matrices', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/easy-mp2rage/web/index.html']);
  assert.deepEqual(plan.apps.include, [{
    app: 'easy-mp2rage',
    path: 'easy-mp2rage',
    runtime: 'rust-wasm',
    rust_wasm: true,
    python_reference: false,
    shared_runtime: false,
    browser_test: true,
    hardware_gpu: false,
    app_scoped_runtime: true,
    release_test: 'test',
  }]);
});

test('release matrix carries an app-specific release test script', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/spinalcordtoolbox/package.json']);
  assert.equal(plan.releaseApps.include[0].app, 'spinalcordtoolbox');
  assert.equal(plan.releaseApps.include[0].release_test, 'test:release');
});

test('documentation-only changes do not spend an app-test matrix', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['docs/adr/0002-hosting-capacity-and-runtime-store.md']);
  assert.deepEqual(plan.apps.include, []);
  assert.equal(plan.allApps, false);
});

test('an app package selects only the apps that use it', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/lcmodel/src/lcmodel-io.js', 'exes/lcmodel/src/state.rs'], await graph);
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(plan.allApps, false);
});

test('packages reached through relative paths still select their apps', async () => {
  const registry = await loadAppsRegistry();
  const selected = createAppPlan(registry, ['exes/greedy/src/lib.rs'], await graph).selected.map((app) => app.id);
  assert.ok(selected.includes('greedy'), 'apps/greedy builds exes/greedy through ../../exes');
  assert.ok(!selected.includes('lcmodel'));
});

test('the shared component package selects every app', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/components/src/ui/ProgressManager.js'], await graph);
  assert.equal(plan.allApps, true);
});

test('an app model manifest selects only that app', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['models/vesselboost.manifest.json']).selected.map((app) => app.id), ['vesselboost']);
});

test('contract tests, tooling, docs and other workflows select no apps and no site build', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, [
    'AGENTS.md',
    'packages/components/CHANGELOG.md',
    'test/app-plan.test.mjs',
    '.github/workflows/lcmodel-native.yml',
    'scripts/quality/package.json',
    'eslint.config.js',
    'config/dependency-baseline.json',
    'templates/app-template/index.html',
  ], await graph);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
});

test('root files the per-app CI jobs run select the complete catalog', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['.github/workflows/ci.yml', 'scripts/lib/e2e-test-data.mjs', 'test-utils/hardware-gpu.mjs']) {
    assert.equal(createAppPlan(registry, [path], await graph).allApps, true, path);
  }
});

test('root files only the composite-site job runs select the site build and no app', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['test/mobile-layout.smoke.mjs', 'test/runtime-assets.test.mjs']) {
    const plan = createAppPlan(registry, [path], await graph);
    assert.deepEqual(plan.selected, [], path);
    assert.equal(plan.site, true, path);
  }
});

test('a root helper selects the apps that import it', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['scripts/lib/dice.mjs'], await graph);
  assert.deepEqual(plan.selected.map((app) => app.id), ['spinalcordtoolbox']);
});

test("a package's tests select only the apps that read them", async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['packages/brain-extraction/test/head-reference.mjs'], await graph).selected.map((app) => app.id), ['brain-extraction']);
  assert.deepEqual(createAppPlan(registry, ['packages/lcmodel/test/lcmodel-io.test.js'], await graph).selected, []);
});

test('a root script that names one package file reaches that file, not the whole package', async () => {
  const registry = await loadAppsRegistry();
  const contracts = createAppPlan(registry, ['packages/desktop/src/contracts.js'], await graph);
  const other = createAppPlan(registry, ['packages/desktop/src/jobs.js'], await graph);
  assert.equal(contracts.allApps, true, 'vite-app-config.mjs reaches contracts.js through app-automation.mjs');
  assert.deepEqual(other.selected.map((app) => app.id), ['dicompare'], 'only dicompare depends on the desktop package');
});

function manifest(before, after) {
  return { before: JSON.stringify(before), after: JSON.stringify(after) };
}

test('a package version bump selects the apps that use the package, since builds embed versions', async () => {
  const registry = await loadAppsRegistry();
  const manifests = new Map([['packages/synthsr/package.json', manifest({ name: 'x', version: '1.0.0' }, { name: 'x', version: '1.1.0' })]]);
  assert.ok(createAppPlan(registry, ['packages/synthsr/package.json'], await graph, manifests).selected.some((app) => app.id === 'synthsr'));
});

test('root test files app e2e scripts run select those apps', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['test/easy-mp2rage-workspace.smoke.mjs'], await graph).selected.map((app) => app.id), ['easy-mp2rage']);
  assert.ok(createAppPlan(registry, ['test/musclemap-full-pipeline-smoke.mjs'], await graph).selected.some((app) => app.id === 'musclemap'));
});

test('files the catalog e2e config reads run the site build', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['test/agentic/catalog.e2e.ts', 'test-utils/agentic-browser.ts', 'scripts/serve-agentic-site.mjs']) {
    assert.equal(createAppPlan(registry, [path], await graph).site, true, path);
  }
});

test('documentation in a package or exes/ directory selects the apps that read it', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['exes/compute-server/README.md'], await graph).selected.map((app) => app.id), ['spinalcordtoolbox']);
});

test('root package.json script edits count only where ci.yml runs them', async () => {
  const registry = await loadAppsRegistry();
  const scripts = { build: 'a', 'new-app': 'b', 'test:mobile': 'c' };
  const resolved = await graph;
  const plan = (after) => createAppPlan(registry, ['package.json'], resolved, new Map([['package.json', manifest({ scripts }, after)]]));
  assert.deepEqual(plan({ scripts: { ...scripts, 'new-app': 'B' } }).selected, []);
  assert.equal(plan({ scripts: { ...scripts, 'new-app': 'B' } }).site, false);
  const site = plan({ scripts: { ...scripts, 'test:mobile': 'C' } });
  assert.deepEqual(site.selected, []);
  assert.equal(site.site, true);
  assert.equal(plan({ scripts, devDependencies: { a: '1' } }).allApps, true);
});

test('an offline asset lock change selects the apps whose assets changed', async () => {
  const registry = await loadAppsRegistry();
  const before = { schemaVersion: 1, assets: { u1: { sha256: 'a' }, u2: { sha256: 'b' } }, apps: { lcmodel: ['u1'], zarro: ['u2'] } };
  const after = { ...before, assets: { ...before.assets, u1: { sha256: 'c' } } };
  const plan = createAppPlan(registry, ['registry/offline-assets.lock.json'], await graph, new Map([['registry/offline-assets.lock.json', manifest(before, after)]]));
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(plan.site, true);
});

test('a root-relative path joined onto a computed repository root selects its app', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['exes/compute-server/src/tools/sct.rs'], await graph);
  assert.ok(plan.selected.some((app) => app.id === 'spinalcordtoolbox'), 'SCT test:release reads the pinned image from sct.rs');
});

test('ci.yml runs the composite site build on pull requests that need it', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs['composite-site'].if, "github.event_name != 'pull_request' || needs.app-plan.outputs.has_site == 'true'");
  assert.equal(ci.jobs['app-plan'].outputs.has_site, '${{ steps.plan.outputs.has_site }}');
});

async function plannerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['scripts/lib', 'registry', '.github/workflows']) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of ['scripts/app-plan.mjs', 'scripts/lib/app-plan.mjs', 'scripts/lib/workspace-graph.mjs', 'scripts/lib/apps-registry.mjs', 'registry/apps.yml']) {
    await copyFile(join(repoRoot, path), join(root, path));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {} }));
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  const ci = { jobs: Object.fromEntries(['composite-site', ...CATALOG_JOBS].map(name => [name, { steps: [{ run: 'echo fixture' }] }])) };
  await writeFile(join(root, '.github/workflows/ci.yml'), stringify(ci));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Planner test');
  git('config', 'user.email', 'planner-test@example.invalid');
  git('add', 'package.json');
  git('commit', '-qm', 'Fixture base');
  const run = (...args) => spawnSync(process.execPath, ['scripts/app-plan.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  return { root, ci, run };
}

test('explicit --only selections work without a usable base', async (t) => {
  const { run } = await plannerFixture(t);
  for (const args of [[], ['--base', '0'.repeat(40)], ['--base', 'missing-ref'], ['--base', 'HEAD']]) {
    const result = run('--only', 'niimath', ...args);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(JSON.parse(output.selected_ids), ['niimath']);
    assert.equal(output.all_apps, 'false');
    assert.equal(output.fallback_reason, '');
  }
  const qsmbly = run('--only', 'qsmbly');
  assert.equal(qsmbly.status, 0, qsmbly.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(qsmbly.stdout).selected_ids), ['qsmbly', 'brain-extraction']);
  const unknown = run('--only', 'not-an-app');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown app ids: not-an-app/);
});

test('affected planning retains full coverage when the base is unavailable', async (t) => {
  const { run } = await plannerFixture(t);
  const registry = await loadAppsRegistry();
  for (const args of [[], ['--base', '0'.repeat(40)], ['--base', 'missing-ref']]) {
    const result = run('--only', 'affected', ...args);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(JSON.parse(output.selected_ids), registry.apps.map(app => app.id));
    assert.equal(output.has_site, 'true');
  }
});

test('missing, renamed and reusable CI jobs trigger a visible full-coverage fallback', async (t) => {
  const { root, ci, run } = await plannerFixture(t);
  const registry = await loadAppsRegistry();
  for (const name of ['composite-site', ...CATALOG_JOBS]) {
    for (const variant of ['missing', 'renamed', 'reusable', 'empty', 'non-array']) {
      const altered = structuredClone(ci);
      if (variant === 'renamed') altered.jobs[`${name}-renamed`] = altered.jobs[name];
      if (variant === 'missing' || variant === 'renamed') delete altered.jobs[name];
      if (variant === 'reusable') altered.jobs[name] = { uses: './.github/workflows/reusable.yml' };
      if (variant === 'empty') altered.jobs[name] = { steps: [] };
      if (variant === 'non-array') altered.jobs[name] = { steps: {} };
      await writeFile(join(root, '.github/workflows/ci.yml'), stringify(altered));
      await assert.rejects(loadWorkspaceGraph(root), error => error instanceof WorkspaceGraphConfigurationError && error.message.includes(name));
      const result = run('--only', 'niimath');
      assert.equal(result.status, 0, `${name} ${variant}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(JSON.parse(output.selected_ids), registry.apps.map(app => app.id));
      assert.equal(output.all_apps, 'true');
      assert.equal(output.has_site, 'true');
      assert.match(output.fallback_reason, new RegExp(name));
      assert.match(result.stderr, /selecting the full catalog and site/);
      assert.deepEqual(JSON.parse(output.browser_apps).include.map(({ app }) => app), registry.apps.filter(app => app.ci.browser_test).map(app => app.id));
      assert.deepEqual(JSON.parse(output.gpu_apps).include.map(({ app }) => app), registry.apps.filter(app => app.ci.hardware_gpu).map(app => app.id));
    }
  }
});

test('unrelated workflow parsing errors remain fatal', async (t) => {
  const { root, run } = await plannerFixture(t);
  await writeFile(join(root, '.github/workflows/ci.yml'), 'jobs: [');
  const result = run('--only', 'niimath');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /YAMLParseError/);
  assert.doesNotMatch(result.stderr, /selecting the full catalog and site/);
});

test('workflow outputs include the fallback reason and complete matrices', async (t) => {
  const { root, ci } = await plannerFixture(t);
  delete ci.jobs['app-tests'];
  await writeFile(join(root, '.github/workflows/ci.yml'), stringify(ci));
  const outputFile = join(root, 'github-output');
  const result = spawnSync(process.execPath, ['scripts/app-plan.mjs', '--only', 'niimath'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile },
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries((await readFile(outputFile, 'utf8')).trim().split('\n').map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  assert.match(outputs.fallback_reason, /app-tests/);
  assert.equal(outputs.all_apps, 'true');
  assert.equal(outputs.has_site, 'true');
  assert.deepEqual(JSON.parse(outputs.selected_ids), (await loadAppsRegistry()).apps.map(app => app.id));
});

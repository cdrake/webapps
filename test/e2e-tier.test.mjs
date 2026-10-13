import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

async function* specFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name)) yield* specFiles(join(dir, entry.name));
    else if (/\.spec\.[cm]?[jt]s$/.test(entry.name)) yield join(dir, entry.name);
  }
}

test('every app with @slow tests applies the pull request tier in its Playwright config', async () => {
  for (const app of await readdir(join(repoRoot, 'apps'))) {
    let tagged = false;
    for await (const file of specFiles(join(repoRoot, 'apps', app))) {
      if ((await readFile(file, 'utf8')).includes("'@slow'")) tagged = true;
    }
    if (!tagged) continue;
    const configs = (await readdir(join(repoRoot, 'apps', app))).filter((name) => /^playwright\.config\./.test(name));
    assert.equal(configs.length, 1, `${app} has one Playwright config`);
    const config = await readFile(join(repoRoot, 'apps', app, configs[0]), 'utf8');
    const builder = config.match(/test-utils\/(playwright-(?:static-app|vite-preview)\.mjs)/)?.[1];
    const source = builder ? await readFile(join(repoRoot, 'test-utils', builder), 'utf8') : config;
    assert.match(source, /e2e-tier\.mjs/, `${app} imports e2eTier`);
    assert.match(source, /\.\.\.e2eTier/, `${app} spreads e2eTier into its config`);
  }
});

test('ci skips @slow tests only on pull requests and logs every test duration', async () => {
  const ci = YAML.parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  assert.equal(ci.env.NEURODESK_E2E_SKIP_SLOW, "${{ github.event_name == 'pull_request' && '1' || '' }}");
  assert.equal(ci.env.PW_TEST_REPORTER, '${{ github.workspace }}/test-utils/test-durations-reporter.mjs');
  const release = await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  assert.doesNotMatch(release, /NEURODESK_E2E_SKIP_SLOW/, 'releases run every test');
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';

const flow = YAML.parse(await readFile(new URL('../.github/workflows/greedy-native.yml', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../packages/greedy/package.json', import.meta.url), 'utf8'));

test('Greedy releases require native and installed npm checks on every target', () => {
  assert.deepEqual(flow.jobs.native.strategy.matrix.include.map((entry) => entry.platform).sort(), ['linux-x64', 'macos-arm64', 'windows-x64']);
  assert.deepEqual(flow.jobs['npm-test'].strategy.matrix.os, flow.jobs.native.strategy.matrix.include.map((entry) => entry.os));
  assert.deepEqual(flow.jobs.npm.needs, ['native', 'macos-sign']);
  assert.match(flow.jobs.npm.if, /needs.macos-sign.result == 'success'/);
  assert.match(flow.jobs.npm.if, /needs.macos-sign.result == 'skipped'/);
  assert.equal(flow.jobs['npm-test'].needs, 'npm');
  assert.deepEqual(flow.jobs.release.needs, ['macos-sign', 'npm-test']);
  assert.equal(flow.jobs['macos-sign'].needs, 'native');
  assert.equal(flow.jobs['macos-sign'].permissions.contents, 'write', 'GitHub draft releases require push access even for lookup');
  assert.equal(flow.jobs['macos-sign'].if, flow.jobs.release.if);
  assert.deepEqual(flow.permissions, { contents: 'read' });
  assert.equal(flow.jobs.release.if, "github.event_name == 'workflow_dispatch' && inputs.sign_release");
  for (const name of ['native', 'npm', 'npm-test']) {
    assert.ok(!JSON.stringify(flow.jobs[name]).includes('secrets.'));
  }
  const steps = flow.jobs.release.steps;
  const target = steps.findIndex((step) => step.name === 'Check release target');
  const signSteps = flow.jobs['macos-sign'].steps;
  const signTarget = signSteps.findIndex((step) => step.name === 'Check release target');
  const sign = signSteps.findIndex((step) => step.name === 'Sign and notarize Apple ARM installer');
  const publish = steps.findIndex((step) => step.name === 'Attach verified packages');
  assert.ok(target >= 0 && target < publish);
  assert.ok(signTarget >= 0 && signTarget < sign);
  const signedNpm = flow.jobs.npm.steps.find((step) => step.with?.name === 'greedy-signed-npm-macos');
  assert.equal(signedNpm.if, "needs.macos-sign.result == 'success'");
  assert.match(steps[publish].run, /greedy-npm-validation-/);
  assert.match(steps[publish].run, /greedy-npm-tarball && shasum/);
  const signature = flow.jobs['npm-test'].steps.find((step) => step.name === 'Verify installed Apple release signature');
  assert.match(signature.if, /inputs.sign_release/);
  assert.match(signature.run, /codesign --verify --strict/);
  assert.match(signature.run, /Authority=Developer ID Application/);
  assert.match(steps[target].run, /git rev-parse/);
  assert.match(steps[target].run, /gh release view "\$tag" >\/dev\/null/);
  assert.doesNotMatch(steps[target].run, /isDraft|isPrerelease/);
});

test('Greedy npm CLI bundles binaries and has no runtime installation downloads', () => {
  assert.equal(manifest.bin['greedy-rs'], './bin/greedy.js');
  assert.ok(manifest.files.includes('native'));
  assert.ok(manifest.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(manifest.files.includes('bin'));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts.install, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
  assert.ok(!manifest.files.includes('wasm'), 'threaded browser runtime remains in the web release');
});

test('offline rollout accounts for every catalog app exactly once', async () => {
  const registry = await loadAppsRegistry();
  const plan = await readFile(new URL('../docs/architecture/offline-executables.md', import.meta.url), 'utf8');
  const planned = [...plan.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((match) => match[1]);
  assert.deepEqual(planned.sort(), registry.apps.map((app) => app.id).sort());
});

test('native and npm distributions retain identical third-party notices', async () => {
  const native = await readFile(new URL('../exes/greedy/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  const npm = await readFile(new URL('../packages/greedy/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.equal(npm, native);
  assert.match(native, /simd-adler32/);
  assert.match(native, /Permission is hereby granted/);
});

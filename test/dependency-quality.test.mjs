import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { compareFindings, dependencyFindings, dependencyGraph, validateRuntimeContracts } from '@neurodesk/dependency-quality';

async function checkFixture(t, files, manifests = new Map(), runtimeContracts = [], setup = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'dependency-canary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), source);
  }
  await setup(root);
  return dependencyFindings(await dependencyGraph(root, Object.keys(files).filter((file) => !file.startsWith('node_modules/'))), manifests, runtimeContracts);
}

const leaf = 'export const value = 1;\n';

function assertUniqueReleaseAgePackages(exclusions) {
  const seen = new Set();
  const duplicates = new Set();
  for (const exclusion of exclusions) {
    const version = exclusion.indexOf('@', 1);
    const name = version < 0 ? exclusion : exclusion.slice(0, version);
    if (/[*?\[\]{}!]/.test(name)) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  assert.equal(duplicates.size, 0, `minimumReleaseAgeExclude matches only the first entry per package. Combine exact versions with || in one entry for: ${[...duplicates].join(', ')}`);
}

test('release-age exclusions have one entry per exact package name', async () => {
  const workspace = parseYaml(await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'));
  assertUniqueReleaseAgePackages(workspace.minimumReleaseAgeExclude ?? []);
});

test('release-age exclusions reject shadowed versions and accept unions and distinct patterns', () => {
  assert.throws(() => assertUniqueReleaseAgePackages([
    '@niivue/niivue@1.0.0-rc.14', '@niivue/niivue@1.0.0-rc.33',
  ]), /Combine exact versions with \|\| in one entry for: @niivue\/niivue/);
  assert.throws(() => assertUniqueReleaseAgePackages(['example@1.0.0', 'example@2.0.0']), /example/);
  assertUniqueReleaseAgePackages([
    '@niivue/niivue@1.0.0-rc.14 || 1.0.0-rc.33',
    'example@1.0.0 || 2.0.0',
    'another@1.0.0',
    '@scope/*',
    '@other/*',
  ]);
});

test('shared production modules cannot import apps, but validation fixtures can', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/index.js': "import '../../../apps/example/src/index.js';\n",
    'packages/example/validation/check.mjs': "import '../../../apps/example/src/index.js';\n",
    'apps/example/src/index.js': leaf,
  });
  assert.equal(findings.filter(({ rule }) => rule === 'shared-to-app').length, 1);
  assert.equal(findings[0].from, 'packages/example/src/index.js');
});

test('an app cannot import another app, including through a worker URL', async (t) => {
  const findings = await checkFixture(t, {
    'apps/first/src/main.js': "new Worker(new URL('../../second/src/worker.js', import.meta.url));\n",
    'apps/second/src/worker.js': leaf,
  });
  assert.ok(findings.some(({ rule }) => rule === 'app-to-other-app'));
});

test('TypeScript and TSX imports are analyzed by the pinned parser', async (t) => {
  const findings = await checkFixture(t, {
    'apps/first/src/main.tsx': "import { value } from '../../second/src/model';\nconst element = <div>{value}</div>;\n",
    'apps/second/src/model.ts': 'export const value: number = 1;\n',
  });
  assert.ok(findings.some(({ rule }) => rule === 'app-to-other-app'));
});

test('volume and core helpers cannot acquire UI imports', async (t) => {
  const findings = await checkFixture(t, {
    'packages/components/src/volume/model.js': "import '../ui/widget.js';\n",
    'packages/components/src/core/dom.js': "import '../ui/widget.js';\n",
    'packages/components/src/ui/widget.js': leaf,
  });
  assert.equal(findings.filter(({ rule }) => rule === 'core-to-ui').length, 2);
});

test('browser paths cannot reach Node code through shared helpers', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import '../../../packages/example/src/index.js';\n",
    'packages/example/src/index.js': "import './node.js';\n",
    'packages/example/src/node.js': "import 'node:fs';\n",
  });
  assert.ok(findings.some(({ rule, from }) => rule === 'browser-to-node' && from === 'packages/example/src/index.js'));
});

test('Node entries cannot reach browser runtime or UI through shared helpers', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/node.js': "import './index.js';\n",
    'packages/example/src/index.js': "import '../../runtime-support/src/niimath/index.js';\n",
    'packages/runtime-support/src/niimath/index.js': leaf,
  });
  assert.ok(findings.some(({ rule }) => rule === 'node-to-browser'));
});

test('Node entries can use the generated niimath factory but cannot use its browser wrapper', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/node.js': "import '../../runtime-support/src/niimath/niimath.js';\nimport '../../runtime-support/src/niimath/index.js';\n",
    'packages/runtime-support/src/niimath/niimath.js': leaf,
    'packages/runtime-support/src/niimath/index.js': leaf,
  });
  assert.deepEqual(findings.filter(({ rule }) => rule === 'node-to-browser'), [{
    rule: 'node-to-browser',
    from: 'packages/example/src/node.js',
    to: 'packages/runtime-support/src/niimath/index.js',
  }]);
});

test('conditional NIfTI zlib fallback does not exempt other Node imports', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import '../../../packages/components/src/file-io/NiftiUtils.js';\n",
    'packages/components/src/file-io/NiftiUtils.js': "await import('node:zlib');\nawait import('node:fs');\n",
  });
  assert.deepEqual(findings.filter(({ rule }) => rule === 'browser-to-node').map(({ to }) => to), ['fs']);
});

test('undeclared runtime dependencies fail even when the root declares them', async (t) => {
  const findings = await checkFixture(t, {
    'package.json': JSON.stringify({ devDependencies: { 'some-root-tool': '1.0.0' } }),
    'node_modules/some-root-tool/package.json': JSON.stringify({ name: 'some-root-tool', main: 'index.js' }),
    'node_modules/some-root-tool/index.js': leaf,
    'packages/example/src/node.js': "import 'some-root-tool';\nimport.meta.resolve('runtime-assets/package.json');\n",
  }, new Map([['packages/example', { name: '@neurodesk/example' }]]));
  assert.deepEqual(findings.filter(({ rule }) => rule === 'undeclared-runtime').map(({ to }) => to), ['runtime-assets', 'some-root-tool']);
});

test('relative workspace imports require a declared runtime dependency', async (t) => {
  const files = {
    'packages/first/src/index.js': "import '../../second/src/index.js';\n",
    'packages/second/src/index.js': leaf,
  };
  const manifests = new Map([
    ['packages/first', { name: '@neurodesk/first' }],
    ['packages/second', { name: '@neurodesk/second' }],
  ]);
  const findings = await checkFixture(t, files, manifests);
  assert.ok(findings.some(({ rule, to }) => rule === 'undeclared-runtime' && to === '@neurodesk/second'));
  manifests.get('packages/first').dependencies = { '@neurodesk/second': 'workspace:*' };
  const declared = await checkFixture(t, files, manifests);
  assert.equal(declared.filter(({ rule }) => rule === 'undeclared-runtime').length, 0);
});

test('relative paths into another workspace or the root node_modules fail, tooling included', async (t) => {
  const files = {
    'apps/example/node_modules/vite/index.js': leaf,
    'node_modules/vite/index.js': leaf,
    'packages/example/node_modules/onnxruntime-web/dist/ort.mjs': leaf,
    'packages/example/src/gpu/verify.mjs': "import '../../../../apps/example/node_modules/vite/index.js';\n",
    'packages/example/validation/check.mjs': "const vite = new URL('../../../node_modules/vite/', import.meta.url);\n",
    'packages/example/src/runtime.js': "const ort = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);\n",
  };
  const manifests = new Map([['apps/example', { name: 'example' }], ['packages/example', { name: '@neurodesk/example' }]]);
  const findings = await checkFixture(t, files, manifests);
  assert.deepEqual(findings.filter(({ rule }) => rule === 'foreign-node-modules').map(({ from, to }) => `${from} -> ${to}`), [
    'packages/example/src/gpu/verify.mjs -> apps/example/node_modules/vite/index.js',
    'packages/example/validation/check.mjs -> node_modules/vite/',
  ]);
});

test('installation paths are read as URLs, nested local installs pass and foreign require anchors fail', async (t) => {
  const files = {
    'node_modules/vite/index.js': leaf,
    'packages/second/package.json': '{}\n',
    'packages/example/node_modules/pkg/node_modules/dep/index.js': leaf,
    'packages/example/validation/encoded.mjs': "const vite = new URL('../../../node%5Fmodules/vite/', import.meta.url);\n",
    'packages/example/validation/dot-encoded.mjs': "const vite = new URL('%2e%2e/%2e%2e/%2e%2e/node_modules/vite/', import.meta.url);\n",
    'packages/example/validation/remote.mjs': "const vite = new URL('https://example.com/node_modules/vite/', import.meta.url);\n",
    'packages/example/validation/backslash.mjs': "const vite = new URL('..\\\\..\\\\..\\\\node_modules\\\\vite\\\\', import.meta.url);\n",
    'packages/example/validation/nested.mjs': "const dep = new URL('../node_modules/pkg/node_modules/dep/index.js', import.meta.url);\n",
    'packages/example/test/native.test.js': "import { createRequire } from 'node:module';\nconst ort = createRequire(new URL('../../second/package.json', import.meta.url))('onnxruntime-node');\nconst own = createRequire(import.meta.url);\nconst pinned = createRequire(new URL('../package.json', import.meta.resolve('@neurodesk/second/index.js')));\n",
    'packages/example/scripts/progress.cjs': "require('./progress%.json');\n",
    'packages/example/scripts/progress%.json': '{}\n',
  };
  const manifests = new Map([['packages/example', { name: '@neurodesk/example' }], ['packages/second', { name: '@neurodesk/second' }]]);
  const findings = await checkFixture(t, files, manifests);
  assert.deepEqual(findings.filter(({ rule }) => rule === 'foreign-node-modules').map(({ from, to }) => `${from} -> ${to}`), [
    'packages/example/test/native.test.js -> packages/second/package.json',
    'packages/example/validation/backslash.mjs -> node_modules/vite/',
    'packages/example/validation/dot-encoded.mjs -> node_modules/vite/',
    'packages/example/validation/encoded.mjs -> node_modules/vite/',
  ]);
});

test('tooling imports need a declaration in the owning workspace, not only the root', async (t) => {
  const files = {
    'package.json': JSON.stringify({ devDependencies: { jsdom: '1.0.0', '@playwright/test': '1.0.0' } }),
    'node_modules/jsdom/package.json': JSON.stringify({ name: 'jsdom', main: 'index.js' }),
    'node_modules/jsdom/index.js': leaf,
    'node_modules/@playwright/test/package.json': JSON.stringify({ name: '@playwright/test', main: 'index.js' }),
    'node_modules/@playwright/test/index.js': leaf,
    'apps/example/e2e/smoke.spec.js': "import { test } from '@playwright/test';\n",
    'apps/example/test/model.test.js': "import { jest } from '@jest/globals';\nimport { JSDOM } from 'jsdom';\n",
    'apps/example/src/main.js': leaf,
  };
  const manifests = new Map([['apps/example', { name: 'example', devDependencies: { jest: '1.0.0' } }]]);
  const findings = await checkFixture(t, files, manifests);
  assert.deepEqual(findings.filter(({ rule }) => rule === 'undeclared-tooling').map(({ from, to }) => `${from} -> ${to}`), [
    'apps/example/e2e/smoke.spec.js -> @playwright/test',
    'apps/example/test/model.test.js -> jsdom',
  ]);
  delete manifests.get('apps/example').devDependencies.jest;
  Object.assign(manifests.get('apps/example').devDependencies, { '@playwright/test': '1.0.0', jsdom: '1.0.0' });
  const declared = await checkFixture(t, files, manifests);
  assert.deepEqual(declared.filter(({ rule }) => rule === 'undeclared-tooling').map(({ to }) => to), ['@jest/globals']);
});

test('Vite asset queries resolve without hiding missing or undeclared assets', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import existing from './asset.wasm?url';\nimport missing from './missing.wasm?url';\n",
    'apps/example/src/asset.wasm': 'fixture',
  });
  assert.deepEqual(findings.filter(({ rule }) => rule === 'unresolved').map(({ to }) => to), ['./missing.wasm?url']);
});

test('cycles include worker URL edges and a new cycle cannot replace an old one', async (t) => {
  const old = await checkFixture(t, {
    'packages/example/src/a.js': "import './b.js';\n",
    'packages/example/src/b.js': "import './a.js';\n",
  });
  const changed = await checkFixture(t, {
    'packages/example/src/a.js': "new Worker(new URL('./c.js', import.meta.url));\n",
    'packages/example/src/c.js': "import './a.js';\n",
  });
  assert.equal(old.filter(({ rule }) => rule === 'cycle').length, 2);
  assert.equal(changed.filter(({ rule }) => rule === 'cycle').length, 2);
  const comparison = compareFindings(changed, old);
  assert.equal(comparison.added.length, 2);
  assert.equal(comparison.removed.length, 2);
});

test('malformed sources fail analysis rather than entering the baseline', async (t) => {
  await assert.rejects(checkFixture(t, { 'apps/example/src/main.ts': 'const = ;\n' }));
});


test('runtime staging exceptions apply only to the exact source and import', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import './staged.mjs';\nimport './missing.mjs';\n",
    'apps/example/src/other.js': "import './staged.mjs';\n",
  }, new Map(), [{ from: 'apps/example/src/main.js', to: './staged.mjs' }]);
  assert.deepEqual(findings.filter(({ rule }) => rule === 'unresolved').map(({ from, to }) => [from, to]), [
    ['apps/example/src/main.js', './missing.mjs'],
    ['apps/example/src/other.js', './staged.mjs'],
  ]);
});

test('generated glue exceptions do not exempt nearby handwritten wrappers', async (t) => {
  const findings = await checkFixture(t, {
    'packages/runtime-support/src/niimath/niimath.js': "import 'node:fs';\n",
    'packages/runtime-support/src/niimath/niimath.js-wrapper.js': "import 'node:fs';\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'browser-to-node').length, 1);
  assert.equal(findings[0].from, 'packages/runtime-support/src/niimath/niimath.js-wrapper.js');
});

test('the desktop browser automation adapter runs in Node', async (t) => {
  const findings = await checkFixture(t, {
    'packages/desktop/src/main.js': "import './browser-automation.js';\n",
    'packages/desktop/src/browser-automation.js': "import 'node:fs';\n",
  });
  assert.equal(findings.length, 0);
});


test('production cannot evade runtime rules by importing test helpers', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.js': "import '../test/helper.js';\n",
    'apps/example/test/helper.js': "import 'node:fs';\n",
  });
  assert.ok(findings.some(({ rule }) => rule === 'runtime-to-tooling'));
});


test('application validation components are production code', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/components/validation/Editor.tsx': "import 'node:fs';\nexport const Editor = () => <div />;\n",
  });
  assert.ok(findings.some(({ rule }) => rule === 'browser-to-node'));
});


test('handwritten vendor modules cannot bypass package-to-app boundaries', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/index.js': "import '../../../apps/example/vendor/helper.js';\n",
    'apps/example/vendor/helper.js': leaf,
  });
  assert.ok(findings.some(({ rule }) => rule === 'shared-to-app'));
});

test('known staged mirrors follow canonical shared sources before build', async (t) => {
  const findings = await checkFixture(t, {
    'apps/calmar/web/js/main.js': "import '../vendor/webapp-components/src/volume/model.js';\n",
    'packages/components/src/volume/model.js': "import 'node:fs';\n",
  });
  assert.ok(findings.some(({ rule, from }) => rule === 'browser-to-node' && from === 'packages/components/src/volume/model.js'));
  assert.equal(findings.filter(({ rule }) => rule === 'unresolved').length, 0);
});


test('explicit type imports do not create runtime cycles', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/a.ts': "import type { Shape } from './b';\nexport const value = 1;\n",
    'packages/example/src/b.ts': "import { value } from './a';\nexport interface Shape { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 0);
});

test('mixed type and runtime imports still create runtime cycles', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/a.ts': "import { type Shape, value } from './b';\nexport const other = 1;\n",
    'packages/example/src/b.ts': "import { other } from './a';\nexport const value = other;\nexport interface Shape { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
});

test('a type import cannot hide a dynamic runtime import of the same module', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/a.ts': "import type { Shape } from './b';\nexport const other = () => import('./b');\n",
    'packages/example/src/b.ts': "import { other } from './a';\nexport interface Shape { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
});

test('Node builtin type imports do not enter the browser runtime graph', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.ts': "import type { Stats } from 'node:fs';\nexport interface File { stats: Stats }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'browser-to-node').length, 0);
});


test('bare pnpm workspace imports reach canonical browser and UI sources', async (t) => {
  const findings = await checkFixture(t, {
    'packages/example/src/node.ts': "import '@fixture/components/ui';\nimport '@fixture/example/browser';\n",
    'packages/example/src/browser.mjs': leaf,
    'packages/example/package.json': JSON.stringify({ name: '@fixture/example', exports: { './browser': './src/browser.mjs' } }),
    'packages/components/src/volume/model.js': "import '@fixture/components/ui';\n",
    'packages/components/src/ui/widget.js': leaf,
    'packages/components/package.json': JSON.stringify({ name: '@fixture/components', exports: { './ui': './src/ui/widget.js' } }),
  }, new Map(), [], async (root) => {
    await mkdir(join(root, 'node_modules/@fixture'), { recursive: true });
    await symlink(join(root, 'packages/example'), join(root, 'node_modules/@fixture/example'));
    await symlink(join(root, 'packages/components'), join(root, 'node_modules/@fixture/components'));
  });
  assert.equal(findings.filter(({ rule }) => rule === 'node-to-browser').length, 2);
  assert.equal(findings.filter(({ rule }) => rule === 'core-to-ui').length, 1);
});

test('a staged ignored file cannot make an exact resolution contract dead', async (t) => {
  const files = { 'apps/example/src/main.js': "import './staged.js';\n" };
  const contracts = [{ from: 'apps/example/src/main.js', to: './staged.js', reason: 'Staged before build.' }];
  const findings = await checkFixture(t, files, new Map(), contracts, async (root) => {
    await writeFile(join(root, 'apps/example/src/staged.js'), leaf);
  });
  assert.equal(findings.length, 0);
});

test('empty production inventories and missing inventory sources abort analysis', async (t) => {
  await assert.rejects(checkFixture(t, { 'packages/example/test/check.js': leaf }), /no production sources/);
  const root = await mkdtemp(join(tmpdir(), 'dependency-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(dependencyGraph(root, ['packages/example/src/missing.js']), /omitted inventory|Could not open|no such file|ENOENT/i);
});

test('runtime contracts reject dead entries and empty reasons', () => {
  const graph = [{ source: 'apps/example/src/main.js', dependencies: [{ module: './staged.js', couldNotResolve: true }] }];
  const contract = { from: 'apps/example/src/main.js', to: './staged.js', reason: 'Generated during build.' };
  assert.doesNotThrow(() => validateRuntimeContracts(graph, [contract]));
  assert.throws(() => validateRuntimeContracts([], [contract]), /unused runtime resolution contract/);
  assert.throws(() => validateRuntimeContracts(graph, [{ ...contract, reason: ' ' }]), /specific reason/);
});


test('a type import cannot hide a literal worker URL with the same specifier', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.ts': "import type { Msg } from './worker.ts';\nnew Worker(new URL('./worker.ts', import.meta.url));\n",
    'apps/example/src/worker.ts': "import './main.ts';\nexport interface Msg { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
});

test('inline type imports retain runtime side effects for verbatimModuleSyntax', async (t) => {
  const findings = await checkFixture(t, {
    'apps/example/src/main.ts': "import { type Msg } from './worker.ts';\n",
    'apps/example/src/worker.ts': "import './main.ts';\nexport interface Msg { value: number }\n",
  });
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
});

test('source and asset inventory resolution is stable through a symlinked checkout', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dependency-checkout-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'real');
  await mkdir(join(root, 'apps/example/src'), { recursive: true });
  await writeFile(join(root, 'apps/example/src/main.js'), "import './worker.js';\nimport './settings.json';\nnew URL('./model.wasm', import.meta.url);\n");
  await writeFile(join(root, 'apps/example/src/worker.js'), "import './main.js';\n");
  await writeFile(join(root, 'apps/example/src/settings.json'), '{}');
  await writeFile(join(root, 'apps/example/src/model.wasm'), 'fixture');
  const alias = join(scratch, 'alias');
  await symlink(root, alias);
  const graph = await dependencyGraph(alias, ['main.js', 'worker.js', 'settings.json', 'model.wasm'].map((file) => 'apps/example/src/' + file));
  const findings = dependencyFindings(graph, new Map());
  assert.equal(findings.filter(({ rule }) => rule === 'cycle').length, 2);
  assert.equal(findings.filter(({ rule }) => rule === 'unresolved').length, 0);
});

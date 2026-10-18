import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadTemplateCatalogue, templateAssets, templateCatalogueErrors } from '../scripts/lib/templates.mjs';
import { templatesFor } from '../packages/components/src/ui/templates.js';

// registry/templates.json lists the built-in fixed images. Adding one is an
// entry, an upload and `node scripts/lock-example-assets.mjs`; these tests
// fail until all three are done.
const catalogue = await loadTemplateCatalogue();
const registry = await loadAppsRegistry();
const readJson = async path => JSON.parse(await readFile(join(repoRoot, path), 'utf8'));

test('the template catalogue is complete and names registered apps', () => {
  assert.deepEqual(templateCatalogueErrors(catalogue, registry.apps.map(app => app.id)), []);
});

test('the catalogue validator rejects incomplete entries and unknown consumers', () => {
  const broken = {
    schema_version: 1,
    consumers: { nowhere: {}, ants: { ids: ['missing'] } },
    templates: [{ id: 'a', label: 'A', dimensionality: 3, dims: [1, 1], spacingMm: [1, 1, 1], sha256: 'x', url: 'https://x/b.nii.gz', filename: 'a.nii.gz' }],
  };
  const errors = templateCatalogueErrors(broken, ['ants']);
  for (const fragment of ['a: space is required', 'a: brainExtracted', 'a: dims', 'a: bytes', 'a: sha256', 'a: url must end', 'a: citation', 'consumer nowhere', 'unknown template missing', 'consumer ants selects no template']) {
    assert.ok(errors.some(error => error.includes(fragment)), `expected an error containing "${fragment}"`);
  }
});

test('templatesFor applies the per-app filter', () => {
  const sample = {
    consumers: { all: {}, one: { ids: ['b'] }, flat: { dimensionality: 2 } },
    templates: [{ id: 'a', dimensionality: 3 }, { id: 'b', dimensionality: 3 }, { id: 'c', dimensionality: 2 }],
  };
  assert.deepEqual(templatesFor(sample, 'all').map(entry => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(templatesFor(sample, 'one').map(entry => entry.id), ['b']);
  assert.deepEqual(templatesFor(sample, 'flat').map(entry => entry.id), ['c']);
  assert.deepEqual(templatesFor(sample, 'other'), []);
});

test('SYNcro fetches its locked template from the catalogue address its manifest records', async () => {
  const [entry] = templatesFor(catalogue, 'syncro');
  const manifest = await readJson('models/syncro.manifest.json');
  const asset = manifest.assets.find(item => item.filename === entry.filename);
  assert.equal(asset.url, entry.url);
  assert.equal(asset.sha256, entry.sha256);
  assert.equal(asset.bytes, entry.bytes);
});

test('BrowserQC\'s air template, the Deface package and both manifests use the catalogue entry', async () => {
  const { AIR_TEMPLATE } = await import('../packages/browserqc/src/pipeline.js');
  for (const app of ['browserqc', 'deface']) {
    const [entry] = templatesFor(catalogue, app);
    const manifest = await readJson(`models/${app}.manifest.json`);
    const asset = manifest.assets.find(item => item.filename === entry.filename);
    assert.deepEqual([asset.url, asset.sha256, asset.bytes], [entry.url, entry.sha256, entry.bytes], `${app} manifest`);
    if (app === 'browserqc') assert.deepEqual([AIR_TEMPLATE.url, AIR_TEMPLATE.sha256, AIR_TEMPLATE.name], [entry.url, entry.sha256, entry.filename]);
  }
  const { TEMPLATE_ASSETS } = await import('../packages/deface/src/templates.js');
  const [entry] = templatesFor(catalogue, 'deface');
  const asset = TEMPLATE_ASSETS.find(item => item.filename === entry.filename);
  assert.deepEqual([asset.url, asset.sha256, asset.bytes], [entry.url, entry.sha256, entry.bytes], '@neurodesk/deface template');
});

test('every offered template is locked for its app with the catalogue checksum', async () => {
  const sources = await readJson('registry/offline-assets.sources.json');
  const lock = await readJson('registry/offline-assets.lock.json');
  for (const asset of templateAssets(catalogue)) {
    const locked = lock.assets[asset.url];
    assert.ok(locked, `${asset.url} is in the offline lock; run scripts/lock-example-assets.mjs`);
    assert.equal(locked.sha256, asset.sha256, `${asset.name} lock checksum`);
    assert.equal(locked.bytes, asset.bytes, `${asset.name} lock size`);
    assert.ok(lock.apps[asset.app].includes(asset.url), `${asset.app} carries ${asset.name} offline`);
    assert.ok(sources.apps[asset.app].some(source => source.url === asset.url), `${asset.app} lists ${asset.name} in offline sources`);
  }
});

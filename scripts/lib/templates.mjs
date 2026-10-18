import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './apps-registry.mjs';
import { templatesFor } from '../../packages/components/src/ui/templates.js';

export const templatesPath = join(repoRoot, 'registry', 'templates.json');

const REQUIRED = ['id', 'label', 'space', 'modality', 'filename', 'url', 'sha256', 'license', 'licenseUrl'];

/** Validation errors for registry/templates.json; an empty list means it is sound. */
export function templateCatalogueErrors(catalogue, appIds) {
  const errors = [];
  if (catalogue.schema_version !== 1) errors.push('schema_version must be 1');
  const ids = new Set();
  for (const entry of catalogue.templates || []) {
    const name = entry.id || '(no id)';
    for (const key of REQUIRED) if (typeof entry[key] !== 'string' || !entry[key]) errors.push(`${name}: ${key} is required`);
    if (ids.has(entry.id)) errors.push(`${name}: duplicate id`);
    ids.add(entry.id);
    if (typeof entry.brainExtracted !== 'boolean') errors.push(`${name}: brainExtracted must be true or false`);
    if (![2, 3].includes(entry.dimensionality)) errors.push(`${name}: dimensionality must be 2 or 3`);
    if (!Array.isArray(entry.dims) || entry.dims.length !== entry.dimensionality) errors.push(`${name}: dims must list one size per dimension`);
    if (!Array.isArray(entry.spacingMm) || entry.spacingMm.length !== entry.dimensionality) errors.push(`${name}: spacingMm must list one spacing per dimension`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) errors.push(`${name}: bytes must be a positive integer`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 || '')) errors.push(`${name}: sha256 must be 64 hex digits`);
    if (!entry.url?.endsWith(`/${entry.filename}`)) errors.push(`${name}: url must end with the filename`);
    const citation = entry.citation || {};
    if (!citation.title || !citation.reference || !(citation.doi || citation.url)) errors.push(`${name}: citation needs title, reference and doi or url`);
  }
  for (const [app, consumer] of Object.entries(catalogue.consumers || {})) {
    if (!appIds.includes(app)) errors.push(`consumer ${app} is not a registered app`);
    for (const id of consumer.ids || []) if (!ids.has(id)) errors.push(`consumer ${app} names unknown template ${id}`);
    if (!templatesFor(catalogue, app).length) errors.push(`consumer ${app} selects no template`);
  }
  return errors;
}

export async function loadTemplateCatalogue(path = templatesPath) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** One offline asset per consumer app and template it offers. */
export function templateAssets(catalogue) {
  return Object.keys(catalogue.consumers || {}).flatMap(app => templatesFor(catalogue, app).map(entry => ({
    app,
    name: entry.filename,
    url: entry.url,
    sha256: entry.sha256,
    bytes: entry.bytes,
    license: entry.license,
    kind: 'template',
  })));
}

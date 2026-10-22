#!/usr/bin/env node
// Writes the NeuroFlow registry bundle the page edits with: one tool per
// catalog operation (as scripts/generate-neuroflow.mjs generates them), the
// launcher those tools run, the shipped workflows, and neuroflow-registry.json.
// The page fetches it from its own path; NeuroFlow clients load the same URL.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTools } from '../../../packages/desktop/neuroflow/generator.mjs';
import { loadAppsRegistry, repoRoot } from '../../../scripts/lib/apps-registry.mjs';
import { loadAppContract } from '../../../scripts/lib/app-automation.mjs';
import { APP } from '../src/config.js';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The bundle as a map of relative path → text. */
export async function bundleFiles() {
  const files = new Map();
  // The builder lists every other app; its own validate operation is not a pipeline step.
  for (const app of (await loadAppsRegistry()).apps.filter(app => app.id !== APP.id)) {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
    const contract = await loadAppContract(app, version);
    if (!contract) throw new Error(`${app.id}: missing automation contract`);
    for (const tool of generateTools(contract)) {
      const { operation } = tool.extensions['neurodesk/automation'];
      files.set(`tools/${app.id}/${operation}.tool.json`, `${JSON.stringify(tool, null, 2)}\n`);
    }
  }
  for (const name of ['neurodesk.mjs', 'contract.mjs', 'stdio.mjs']) {
    files.set(`scripts/${name}`, await readFile(join(repoRoot, 'packages/desktop/neuroflow/runtime', name), 'utf8'));
  }
  const workflows = (await readdir(join(appDir, 'workflows'))).filter(name => name.endsWith('.workflow.json')).sort();
  for (const name of workflows) files.set(`workflows/${name}`, await readFile(join(appDir, 'workflows', name), 'utf8'));
  const index = {
    neuroflow: '0.1.1',
    kind: 'neuroflow/registry-index',
    title: 'Neurodesk web apps',
    tools: [...files.keys()].filter(path => path.startsWith('tools/')).sort(),
    workflows: workflows.map(name => `workflows/${name}`),
  };
  files.set('neuroflow-registry.json', `${JSON.stringify(index, null, 2)}\n`);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = join(appDir, 'public/neuroflow');
  const files = await bundleFiles();
  await rm(out, { recursive: true, force: true });
  for (const [path, text] of files) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), text);
  }
  const index = JSON.parse(files.get('neuroflow-registry.json'));
  console.log(`NeuroFlow bundle: ${index.tools.length} tools, ${index.workflows.length} workflows in ${out}`);
}

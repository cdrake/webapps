#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { loadAppContract } from './lib/app-automation.mjs';

const args = process.argv.slice(2);
let reportPath;
let allowMissing = false;
while (args.length) {
  const arg = args.shift();
  if (arg === '--allow-missing') allowMissing = true;
  else if (arg === '--report' && args.length) reportPath = resolve(args.shift());
  else throw new Error(`Unknown or incomplete argument: ${arg}`);
}

const { apps } = await loadAppsRegistry();
const entries = [];
for (const app of apps) {
  const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
  const contract = await loadAppContract(app, version);
  entries.push({
    app: app.id,
    version,
    contract: contract ? `apps/${app.id}/automation.json` : null,
    declared: Boolean(contract),
    operations: contract ? Object.keys(contract.operations ?? { run: contract }) : [],
  });
}
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  scope: 'Contract declarations only; scientific and browser execution need separate evidence.',
  declared: entries.filter(entry => entry.declared).length,
  total: entries.length,
  entries,
};
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`Automation contracts: ${report.declared}/${report.total}`);
const missing = entries.filter(entry => !entry.declared).map(entry => entry.app);
if (missing.length) {
  console.error(`Missing contracts: ${missing.join(', ')}`);
  if (!allowMissing) process.exitCode = 1;
}

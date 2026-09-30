import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadAppsRegistry, findApp, repoRoot } from './lib/apps-registry.mjs';
import { loadAppContract } from './lib/app-automation.mjs';
import { generateJob, validateRequest } from '../packages/desktop/src/contracts.js';

const [appId, requestPath, outputPath] = process.argv.slice(2);
if (!appId || !requestPath || !outputPath) throw new Error('Usage: node scripts/automation-job.mjs <app> <request.json> <job.json>');
const app = findApp(await loadAppsRegistry(), appId);
const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', appId, 'package.json')));
const contract = await loadAppContract(app, version);
if (!contract) throw new Error(`No automation contract for ${appId}`);
const request = await validateRequest(contract, JSON.parse(await readFile(resolve(requestPath), 'utf8')));
await writeFile(resolve(outputPath), `${JSON.stringify(generateJob(contract, request), null, 2)}\n`);
console.log(`Wrote ${appId} job to ${resolve(outputPath)}`);

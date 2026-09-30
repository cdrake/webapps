import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { inventoryFiles, verifyBundle } from '../../packages/desktop/src/bundle.js';
import { readVolume } from '../../packages/synthsr/src/volume.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = join(root, 'apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz');
const synthsegFixture = join(root, 'exes/synthseg/test/fixtures/small.nii.gz');
const appIds = ['brain-extraction', 'synthseg'];
const scratch = await mkdtemp(join(tmpdir(), 'neurodesk-automation-smoke-'));
const evidence = process.env.NEURODESK_TEST_REPORT;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const volume = bytes => readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const summary = { passed: false, protocolVersion: '2025-11-25', apps: appIds, synthsegInference: 'Not run; this check exercises scientific BET processing.' };

async function disableAnalytics(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await disableAnalytics(path);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      await writeFile(path, html.replace(/<script\b[^>]*src=["'][^"']*(?:cloudflareinsights|googletagmanager)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, ''));
    } else if (entry.name === 'analytics.js') {
      await writeFile(path, 'export function initAnalytics() { return { enabled: false, reason: "offline" }; }\n');
    }
  }
}

async function focusedBundle() {
  const bundle = join(scratch, 'bundle');
  await mkdir(join(bundle, 'site'), { recursive: true });
  const apps = [];
  for (const id of appIds) {
    const dist = join(root, 'apps', id, 'dist');
    const contract = JSON.parse(await readFile(join(dist, 'automation.json'), 'utf8'));
    await cp(dist, join(bundle, 'site', id), { recursive: true });
    apps.push({ id, path: id, title: contract.title });
  }
  await writeFile(join(bundle, 'site/index.html'), '<!doctype html><title>Automation verification</title>\n');
  await disableAnalytics(join(bundle, 'site'));
  const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'), 'utf8')).version;
  const files = await inventoryFiles(bundle);
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version, defaultApp: null, apps, assets: {}, files }));
  summary.bundle = await verifyBundle(bundle);
  return bundle;
}

function connect(bundle) {
  const require = createRequire(join(root, 'packages/desktop/package.json'));
  const executable = process.env.NEURODESK_EXECUTABLE || require('electron');
  const env = {
    ...process.env,
    NEURODESK_BUNDLE: bundle,
    NEURODESK_USER_DATA: join(scratch, 'profile'),
    NEURODESK_SOFTWARE_RENDERING: process.env.NEURODESK_SOFTWARE_RENDERING || '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NEURODESK_MODELS_DIR;
  const args = [
    ...(process.env.NEURODESK_CONTAINER === '1' ? ['--no-sandbox'] : []),
    ...(process.env.NEURODESK_EXECUTABLE ? [] : [join(root, 'packages/desktop')]),
    '--mcp', '--output', join(scratch, 'runs'),
  ];
  const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let stderr = Buffer.alloc(0);
  let failure;
  let closed = false;
  let messages = 0;
  const fail = error => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536); });
  child.once('error', fail);
  child.stdin.on('error', fail);
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    if (pending.size) fail(new Error(`Desktop exited with ${code ?? signal}: ${stderr.toString('utf8')}`));
    resolve({ code, signal });
  }));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0', 'Desktop stdout must contain only JSON-RPC');
      assert.ok('result' in message || 'error' in message || typeof message.method === 'string');
      ++messages;
      if (pending.has(message.id)) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      }
    } catch (error) {
      fail(new Error(`Non-protocol desktop stdout: ${line.slice(0, 240)}`, { cause: error }));
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure || closed) {
      reject(failure || new Error('Desktop connection is closed'));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Desktop timed out answering ${method}: ${stderr.toString('utf8')}`));
    }, 60000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    async call(method, params) {
      const response = await request(method, params);
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    },
    async tool(name, args = {}) {
      const response = await this.call('tools/call', { name, arguments: args });
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      return response.structuredContent;
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    diagnostics() {
      return stderr.toString('utf8');
    },
    async end() {
      child.stdin.end();
      let timer;
      try {
        const status = await Promise.race([
          exited,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop did not exit after stdin closed')), 15000); }),
        ]);
        if (failure) throw failure;
        assert.equal(status.code, 0, `Desktop exited ${status.code ?? status.signal}: ${stderr.toString('utf8')}`);
        return { ...status, messages };
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose() {
      if (!closed) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

async function waitForRun(client, id) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const snapshot = await client.tool('runs_get', { runId: id });
    if (snapshot.state !== 'running') return snapshot;
    await delay(250);
  }
  throw new Error(`BET run ${id} did not complete in five minutes`);
}

let client;
try {
  const bundle = await focusedBundle();
  client = connect(bundle);
  const initialized = await client.call('initialize', {
    protocolVersion: summary.protocolVersion,
    capabilities: {},
    clientInfo: { name: 'neurodesk-production-smoke', version: '1.0.0' },
  });
  assert.equal(initialized.protocolVersion, summary.protocolVersion);
  client.notify('notifications/initialized');
  const tools = (await client.call('tools/list')).tools;
  assert.ok(tools.every(tool => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)), 'MCP tools must have portable names');
  for (const name of ['run_brain_extraction', 'run_synthseg']) {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, `Missing generated tool: ${name}`);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.inputs.additionalProperties, false);
  }
  const contracts = (await client.tool('apps_list')).apps;
  assert.deepEqual(contracts.map(contract => contract.app).sort(), appIds);
  for (const app of appIds) {
    await client.tool('apps_validate', { app, inputs: { image: [app === 'synthseg' ? synthsegFixture : fixture] } });
  }
  for (const name of ['apps_validate', 'runs_start']) {
    const oversized = await client.call('tools/call', {
      name,
      arguments: { app: 'synthseg', inputs: { image: [fixture] } },
    });
    assert.equal(oversized.isError, true);
    assert.match(oversized.content[0].text, /padded to 224×256×192.*above the validated 2 GiB limit/);
  }
  summary.preflight = { synthsegSmall: 'accepted', oversizedValidation: 'rejected', oversizedStart: 'rejected' };
  const invalid = await client.call('tools/call', {
    name: 'apps_validate',
    arguments: { app: 'brain-extraction', inputs: { image: [join(scratch, 'missing.nii')] } },
  });
  assert.equal(invalid.isError, true);
  const request = { inputs: { image: [fixture] }, parameters: { method: 'bet', threshold: 0.5 }, timeoutMs: 300000, retainViewer: true };
  const abandoned = await client.tool('run_brain_extraction', request);
  const cancelled = await client.tool('runs_cancel', { runId: abandoned.id });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.report, undefined);
  assert.deepEqual((await client.call('resources/list')).resources, []);

  const started = await client.tool('run_brain_extraction', request);
  const finished = await waitForRun(client, started.id);
  assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  const reportResource = await client.call('resources/read', { uri: finished.reportUri });
  const report = JSON.parse(reportResource.contents[0].text);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.app, 'brain-extraction');
  assert.equal(report.inputs.image[0].sha256, hash(await readFile(fixture)));
  const artifacts = {};
  for (const [role, descriptor] of Object.entries(report.artifacts)) {
    const uri = `neurodesk://runs/${started.id}/artifacts/${role}`;
    const resource = (await client.call('resources/read', { uri })).contents[0];
    const bytes = resource.blob ? Buffer.from(resource.blob, 'base64') : Buffer.from(resource.text);
    assert.equal(bytes.length, descriptor.bytes, `${role} byte count`);
    assert.equal(hash(bytes), descriptor.sha256, `${role} checksum`);
    artifacts[role] = bytes;
  }
  const original = volume(await readFile(fixture));
  const brain = volume(artifacts.brain);
  const mask = volume(artifacts.mask);
  assert.deepEqual(mask.dims, original.dims);
  assert.deepEqual(mask.affine, original.affine);
  assert.deepEqual(brain.affine, original.affine);
  assert.ok(mask.data.every(value => value === 0 || value === 1));
  const binary = Uint8Array.from(mask.data);
  const voxelCount = binary.reduce((sum, value) => sum + value, 0);
  const maskSha256 = hash(binary);
  // Golden values are pinned by apps/brain-extraction/e2e/app.spec.js.
  assert.equal(voxelCount, 246875);
  assert.equal(maskSha256, '107a46c3a2f42f4a7796dc5a5b2a6660a302239ae50a0cf2eea80b1767a50862');
  assert.ok(brain.data.every((value, index) => value === (binary[index] ? original.data[index] : 0)));
  assert.equal(JSON.parse(artifacts.report).runId, report.runId);
  const sessionId = finished.session.id;
  const sessions = await client.tool('sessions_list');
  assert.equal(sessions.sessions[0].runId, finished.id);
  const { viewers } = await client.tool('viewers_list', { sessionId });
  assert.equal(viewers[0].capabilities.crosshair, true);
  const voxel = mask.dims.map(size => Math.floor(size * 0.4));
  const mm = mask.affine.slice(0, 3).map(row => row[0] * voxel[0] + row[1] * voxel[1] + row[2] * voxel[2] + row[3]);
  const position = await client.tool('viewers_crosshair', { sessionId, viewerId: viewers[0].id, position: { frame: 'mm', value: mm } });
  position.position.value.forEach((value, axis) => assert.ok(Math.abs(value - mm[axis]) < 1e-3));
  const tab = await client.tool('viewers_tab', { sessionId, viewerId: viewers[0].id, tabId: 'mask' });
  assert.equal(tab.tabs.find(entry => entry.id === 'mask').active, true);
  const regions = viewers[0].capabilities.regions
    ? await client.tool('viewers_regions', { sessionId, viewerId: viewers[0].id }) : { supported: false };
  summary.viewer = { viewers, position, regions };
  const eofRun = await client.tool('run_brain_extraction', request);
  summary.exit = await client.end();
  const afterEof = JSON.parse(await readFile(join(scratch, 'runs', eofRun.id, 'run.json'), 'utf8'));
  assert.equal(afterEof.state, 'cancelled');
  assert.equal(afterEof.report, undefined);
  summary.bet = { voxelCount, maskSha256, artifacts: report.artifacts, provenance: report.provenance };
  summary.cancellation = { requested: cancelled.state, stdinClosed: afterEof.state };
  summary.passed = true;
  console.log(`Automation smoke passed: both contracts discovered; BET mask ${voxelCount} voxels; artifacts and retained viewer verified; cancellation and clean EOF exit verified.`);
} catch (error) {
  summary.error = error.stack || error.message;
  console.error(summary.error);
  if (client) console.error(client.diagnostics());
  process.exitCode = 1;
} finally {
  await client?.dispose();
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'automation-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
  await rm(scratch, { recursive: true, force: true });
}

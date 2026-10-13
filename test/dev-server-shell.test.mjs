import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

async function startDevServer(args) {
  const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'dev-server.mjs'), ...args], { cwd: join(repoRoot, 'apps', 'musclemap'), stdio: 'ignore' });
  const port = args[args.indexOf('--port') + 1];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return { child, origin: `http://127.0.0.1:${port}` };
    } catch {
      await sleep(100);
    }
  }
  child.kill();
  throw new Error('dev server did not start');
}

test('dev-server --app serves the page with the shared shell and no analytics', async (t) => {
  const { child, origin } = await startDevServer(['--dir', 'web', '--app', 'musclemap', '--port', '8793']);
  t.after(async () => { child.kill(); await rm(join(repoRoot, 'apps', 'musclemap', 'web', `.dev-server-${new URL(origin).port}.pid`), { force: true }); });
  const html = await (await fetch(`${origin}/`)).text();
  assert.match(html, /data-neurodesk-app="musclemap"/);
  assert.match(html, /data-neurodesk-app-information>[^<]*10\.1038\/s41592-023-02145-x/);
  assert.match(html, /src="\.\/app-shell\.js"/);
  assert.equal((await fetch(`${origin}/app-shell.js`)).status, 200);
  assert.equal((await fetch(`${origin}/shell-adapters/static-html.js`)).status, 200);
  assert.equal(await (await fetch(`${origin}/analytics.js`)).text(), 'export function initAnalytics() {}\n');
  assert.equal((await fetch(`${origin}/standalone.json`)).status, 200);
  for (const name of ['core/dom.js', 'ui/renderInfoDialog.js', 'ui/renderStandalone.js', 'styles/imaging-workspace.css', 'styles/base.css']) {
    assert.equal((await fetch(`${origin}/shell-adapters/components/${name}`)).status, 200, name);
  }
});

test('dev-server without --app serves the page unthemed', async (t) => {
  const { child, origin } = await startDevServer(['--dir', 'web', '--port', '8794']);
  t.after(async () => { child.kill(); await rm(join(repoRoot, 'apps', 'musclemap', 'web', `.dev-server-${new URL(origin).port}.pid`), { force: true }); });
  const html = await (await fetch(`${origin}/`)).text();
  assert.doesNotMatch(html, /data-neurodesk-app-information/);
  assert.equal((await fetch(`${origin}/app-shell.js`)).status, 404);
});

import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [runtimeDirectory, oracleDirectory] = process.argv.slice(2);
if (!runtimeDirectory || !oracleDirectory) throw new Error('Usage: node verify-browser.mjs RUNTIME_DIRECTORY ORACLE_DIRECTORY');
const manifest = JSON.parse(await readFile(resolve(oracleDirectory, 'manifest.json'), 'utf8'));
const runtimeManifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const routes = new Map([
  ['/packages/nesvor/src/n4/index.js', new URL('./index.js', import.meta.url)],
  ['/packages/nesvor/src/n4/loader.js', new URL('./loader.js', import.meta.url)],
  ['/packages/components/src/worker/fetchModel.js', new URL('../../../components/src/worker/fetchModel.js', import.meta.url)],
  ['/nesvor-n4.mjs', resolve(runtimeDirectory, 'nesvor-n4.mjs')],
  ['/nesvor-n4.wasm', resolve(runtimeDirectory, 'nesvor-n4.wasm')],
]);
for (const fixture of manifest.cases) {
  for (const suffix of ['input', 'mask', 'expected']) {
    routes.set(`/${fixture.name}-${suffix}.bin`, resolve(oracleDirectory, `${fixture.name}-${suffix}.bin`));
  }
}
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>N4 verification</title>');
    return;
  }
  try {
    const file = routes.get(request.url);
    if (!file) throw new Error('Unknown verification asset');
    response.setHeader('Content-Type', request.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const reports = await page.evaluate(async ({ cases, runtimeManifest }) => {
    const { createN4Corrector } = await import('/packages/nesvor/src/n4/loader.js');
    const correct = await createN4Corrector({ baseUrl: new URL('/', location.href).href, manifest: runtimeManifest });
    const reports = [];
    for (const fixture of cases) {
      const read = async (suffix, Type) => new Type(await (await fetch(`/${fixture.name}-${suffix}.bin`)).arrayBuffer());
      const data = await read('input', Float32Array);
      const mask = await read('mask', Uint8Array);
      const expected = await read('expected', Float32Array);
      const actual = correct({ data, mask: fixture.unmasked ? undefined : mask, shape: fixture.shape, resolution: fixture.resolution }, fixture.options);
      let maxAbsoluteError = 0;
      for (let i = 0; i < actual.length; i++) {
        if (!Number.isFinite(actual[i]) || !Number.isFinite(expected[i])) throw new Error('Non-finite N4 result');
        maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(actual[i] - expected[i]));
      }
      if (maxAbsoluteError > 0.0001) throw new Error(`N4 disagreement: ${maxAbsoluteError}`);
      reports.push({ case: fixture.name, maxAbsoluteError });
    }
    return reports;
  }, { cases: manifest.cases, runtimeManifest });
  console.log(JSON.stringify({ browser: browser.version(), reports }, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

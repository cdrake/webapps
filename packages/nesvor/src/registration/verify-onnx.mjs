import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const models = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Pass an external model export directory.');
const runtime = fileURLToPath(new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = fileURLToPath(new URL('./', import.meta.url));
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const filename = url.pathname.split('/').pop();
    if (!filename) { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><title>SVoRT verification</title>'); return; }
    const directory = url.pathname.startsWith('/models/') ? models : url.pathname.startsWith('/runtime/') ? runtime : source;
    const type = {'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json'}[extname(filename)] ?? 'application/octet-stream';
    response.setHeader('Content-Type', type);
    response.end(await readFile(url.pathname.startsWith('/packages/') ? resolve(root, '.' + url.pathname) : resolve(directory, filename)));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({args:['--no-sandbox']});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async (modelBaseUrl) => {
    const runtime = await import('/runtime/ort.webgpu.min.mjs');
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.wasmPaths = new URL('/runtime/',location.href).href;
    const {createOnnxLearnedStep} = await import('/packages/nesvor/src/registration/onnx.js');
    const manifest = await (await fetch('/models/svort-manifest.json')).json();
    const learned = await createOnnxLearnedStep({runtime,manifest,baseUrl:modelBaseUrl ?? new URL('/models/',location.href).href});
    const errors = [];
    try {
      for (const iteration of [0,1]) {
        const fixture = await (await fetch(`/models/browser-fixture-${iteration}.json`)).json();
        const result = await learned({...fixture,iteration,count:7,sliceShape:[128,128]});
        for (const key of ['theta','score']) {
          let max = 0;
          result[key].forEach((value,i) => {
            const expected = fixture.expected[key][i];
            const error = Math.abs(value-expected);
            max = Math.max(max,error);
            if (error > (key === 'theta' ? 0.001 : 0.0001)) throw new Error(`${iteration} ${key} ${i}: ${value} != ${expected}`);
          });
          errors.push({iteration,output:key,maxAbsoluteError:max});
        }
      }
    } finally { await learned.release(); }
    return {passed:true,executionProvider:'wasm',errors};
  }, process.env.NESVOR_VERIFY_MODEL_URL ?? null);
  console.log(JSON.stringify(result,null,2));
} finally {
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}

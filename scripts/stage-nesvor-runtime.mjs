import { createRequire } from 'node:module';
import { readFile, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'packages/nesvor/package.json'));
const runtime = dirname(require.resolve('onnxruntime-web/wasm'));
const output = join(root, 'apps/nesvor/public/ort');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const runtimeName = 'ort-wasm-simd-threaded.jsep';
await copyFile(join(runtime, `${runtimeName}.mjs`), join(output, `${runtimeName}.mjs`));
await writeFile(join(output, `${runtimeName}.wasm.gz`), gzipSync(await readFile(join(runtime, `${runtimeName}.wasm`)), { level: 9 }));
const modelOutput = join(root, 'apps/nesvor/public/svort');
const source = process.env.NESVOR_MODEL_DIR;
if (source) {
  const manifest = JSON.parse(await readFile(join(root, 'packages/nesvor/src/registration/svort-manifest.json'), 'utf8'));
  for (const record of manifest.models) {
    const bytes = await readFile(resolve(source, record.file));
    if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error(`SVoRT asset verification failed: ${record.file}`);
  }
  await mkdir(modelOutput, { recursive: true });
  for (const record of manifest.models) await copyFile(resolve(source, record.file), join(modelOutput, record.file));
} else {
  await rm(modelOutput, { recursive: true, force: true });
  console.log('SVoRT uses pinned hosted models. Set NESVOR_MODEL_DIR to bundle the verified models locally.');
}

const n4Manifest = JSON.parse(await readFile(join(root, 'packages/nesvor/src/n4/manifest.json'), 'utf8'));
const n4Output = join(root, 'apps/nesvor/public/n4');
const n4Source = process.env.NESVOR_N4_DIR;
const n4Cache = join(process.env.TMPDIR || '/storage/home/ubuntu/.tmp', 'nesvor-runtime-cache', 'n4');
await mkdir(n4Output, { recursive: true });
await mkdir(n4Cache, { recursive: true });
for (const record of n4Manifest.files) {
  const verify = (bytes) => bytes.length === record.bytes && createHash('sha256').update(bytes).digest('hex') === record.sha256;
  const cached = join(n4Cache, `${record.sha256}-${record.file}`);
  let bytes;
  if (n4Source) {
    bytes = await readFile(resolve(n4Source, record.file));
    if (!verify(bytes)) throw new Error(`N4 asset verification failed: ${record.file}`);
  } else {
    bytes = await readFile(cached).catch(() => null);
    if (!bytes || !verify(bytes)) {
      const response = await fetch(new URL(record.file, n4Manifest.base_url));
      if (!response.ok) throw new Error(`N4 asset download failed (${response.status}): ${record.file}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (!verify(bytes)) throw new Error(`N4 asset verification failed: ${record.file}`);
      await writeFile(cached, bytes);
    }
  }
  await writeFile(join(n4Output, record.file), bytes);
}
await copyFile(join(root, 'packages/nesvor/native-n4/NOTICE'), join(n4Output, 'NOTICE'));
await copyFile(join(root, 'packages/nesvor/native-n4/LICENSE.Apache-2.0'), join(n4Output, 'LICENSE.Apache-2.0'));
await copyFile(join(root, 'packages/nesvor/LICENSE'), join(n4Output, 'LICENSE.MIT'));
console.log('Staged verified ITK N4 WebAssembly runtime.');

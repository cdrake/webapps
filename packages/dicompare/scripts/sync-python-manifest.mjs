#!/usr/bin/env node
// Writes python.manifest.json from the offline inventory: the Pyodide packages and wheels the
// installed suite stages for dicompare, with the checksums registry/offline-assets.lock.json pins.
// With --check it fails instead of writing when the committed manifest differs.
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const manifestPath = fileURLToPath(new URL('../python.manifest.json', import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));

export async function pythonManifest() {
  const sources = await readJson('registry/offline-assets.sources.json');
  const { assets } = await readJson('registry/offline-assets.lock.json');
  const pyodideLock = JSON.parse(await readFile(new URL('../node_modules/pyodide/pyodide-lock.json', import.meta.url), 'utf8'));
  const { base, packages, wheels } = sources.python;
  const version = /\/pyodide\/v([^/]+)\/full\/$/.exec(base)?.[1];
  if (version !== pyodideLock.info.version) {
    throw new Error(`The offline inventory pins Pyodide ${version}; the package depends on ${pyodideLock.info.version}`);
  }
  const pinned = (url) => {
    const asset = assets[url];
    if (!asset) throw new Error(`${url} is not in registry/offline-assets.lock.json`);
    return { name: basename(new URL(url).pathname), url, sha256: asset.sha256, bytes: asset.bytes };
  };
  const packageFiles = packages.map((name) => {
    const entry = pyodideLock.packages[name];
    if (!entry) throw new Error(`Pyodide ${version} has no package ${name}`);
    const file = pinned(base + entry.file_name);
    if (file.sha256 !== entry.sha256) throw new Error(`${entry.file_name} differs from pyodide-lock.json`);
    return file;
  });
  const core = ['pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'].map((name) => pinned(base + name));
  return { pyodide: version, core, packages, packageFiles, wheels: wheels.map(pinned) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(await pythonManifest(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (text !== await readFile(manifestPath, 'utf8')) {
      console.error('python.manifest.json is out of date: run node packages/dicompare/scripts/sync-python-manifest.mjs');
      process.exitCode = 1;
    }
  } else {
    await writeFile(manifestPath, text);
  }
}

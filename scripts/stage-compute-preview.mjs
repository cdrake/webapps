#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateComputeServer } from './lib/standalone.mjs';

const [metadataPath, outputPath] = process.argv.slice(2);
if (!metadataPath || !outputPath) throw new Error('Usage: node scripts/stage-compute-preview.mjs ARCHIVE_METADATA_JSON EXTERNAL_OUTPUT_DIRECTORY');
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
await mkdir(resolve(outputPath), { recursive: true });
const output = await realpath(resolve(outputPath));
if (!relative(root, output).startsWith('..')) throw new Error('Preview binaries belong outside the source repository.');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
if (metadata.platform !== 'linux-x64' || !/^neurodesk-compute-[0-9.]+-linux-x64\.tar\.gz$/.test(metadata.archive)) throw new Error('Expected a Linux compute-server archive.');
const archive = join(dirname(resolve(metadataPath)), metadata.archive);
const bytes = await readFile(archive);
if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('Archive does not match its size/checksum metadata.');
const catalog = JSON.parse(await readFile(join(root, 'registry/standalone.json'), 'utf8'));
const url = `/nesvor/downloads/${metadata.archive}`;
catalog.apps.nesvor.computeServer.download = { filename: metadata.archive, version: metadata.version, url, checksumUrl: `${url}.sha256`, bytes: metadata.bytes, sha256: metadata.sha256, preview: true };
validateComputeServer(catalog.apps.nesvor.computeServer, 'nesvor');
await mkdir(join(output, 'downloads'), { recursive: true });
await copyFile(archive, join(output, 'downloads', metadata.archive));
await writeFile(join(output, 'downloads', `${metadata.archive}.sha256`), `${metadata.sha256}  ${metadata.archive}\n`);
await writeFile(join(output, 'standalone.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Staged verified preview download and catalog at ${output}`);

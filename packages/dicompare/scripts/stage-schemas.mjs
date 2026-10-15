#!/usr/bin/env node
// Copies the web app's schema library (apps/dicompare/public/schemas, listed by its index.json)
// into schemas/, which the command line ships. The directory is generated and gitignored.
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../apps/dicompare/public/schemas/', import.meta.url));
const destination = fileURLToPath(new URL('../schemas/', import.meta.url));
const index = JSON.parse(await readFile(join(source, 'index.json'), 'utf8'));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(join(source, 'index.json'), join(destination, 'index.json'));
for (const path of index) await copyFile(join(source, basename(path)), join(destination, basename(path)));

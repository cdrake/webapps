import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createN4Corrector } from './index.js';

const [runtimeDirectory, oracleDirectory] = process.argv.slice(2);
if (!runtimeDirectory || !oracleDirectory) throw new Error('Usage: node verify-oracle.mjs RUNTIME_DIRECTORY ORACLE_DIRECTORY');
const { default: createModule } = await import(pathToFileURL(path.resolve(runtimeDirectory, 'nesvor-n4.mjs')));
const module = await createModule();
const correct = createN4Corrector(module);
const manifest = JSON.parse(await fs.readFile(path.join(oracleDirectory, 'manifest.json'), 'utf8'));
for (const fixture of manifest.cases) {
  const read = async (suffix, Type) => {
    const bytes = await fs.readFile(path.join(oracleDirectory, `${fixture.name}-${suffix}.bin`));
    return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const data = await read('input', Float32Array);
  const mask = await read('mask', Uint8Array);
  const expected = await read('expected', Float32Array);
  const actual = correct({ data, mask: fixture.unmasked ? undefined : mask, shape: fixture.shape, resolution: fixture.resolution }, fixture.options);
  let maxAbsoluteError = 0;
  let sumSquaredError = 0;
  for (let i = 0; i < actual.length; i++) {
    assert.ok(Number.isFinite(actual[i]));
    const error = Math.abs(actual[i] - expected[i]);
    maxAbsoluteError = Math.max(maxAbsoluteError, error);
    sumSquaredError += error * error;
  }
  const rmse = Math.sqrt(sumSquaredError / actual.length);
  console.log(JSON.stringify({ case: fixture.name, simpleITK: manifest.simpleITK, maxAbsoluteError, rmse }));
  assert.ok(maxAbsoluteError < 0.0001 && rmse < 0.00001, 'ITK WASM N4 must agree with upstream SimpleITK');
}

#!/usr/bin/env node
import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cachedAsset } from './verify-nesvor-real.mjs';
import { readVolume } from '../packages/synthsr/src/volume.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export function requireHardwareAdapter(info) {
  if (!info || info.fallback || ![info.vendor, info.architecture, info.device, info.description].some(Boolean)) throw new Error('A reported hardware WebGPU adapter is required.');
  if (/swiftshader|llvmpipe|lavapipe|software|microsoft basic render/i.test(JSON.stringify(info))) throw new Error('Full-acquisition validation refuses software WebGPU adapters.');
}

export function validateBrowserOutput(bytes, provenance) {
  const required = { registration: 'svort', iterations: 6000, batchSize: 4096, samples: 256, log2Size: 19, outputResolution: 0.8 };
  if (provenance?.engine !== 'browser-webgpu' || provenance.sourceCommit !== '730ddaa3711a2304386de34193ea4b957892fe7b') throw new Error('Unexpected browser reconstruction engine.');
  for (const [key, value] of Object.entries(required)) {
    if (provenance.config?.[key] !== value) throw new Error(`Full-acquisition validation requires default ${key}=${value}.`);
  }
  if (!provenance.preprocessing?.segmentation || !provenance.preprocessing.biasFieldCorrection || provenance.outputSamples !== 512) throw new Error('Full fetal-brain preprocessing and output sampling are required.');
  const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!volume.data.every(value => Number.isFinite(value) && value >= 0)) throw new Error('Output contains negative or non-finite intensities.');
  const positive = volume.data.filter(value => value > 0);
  if (!positive.length || positive.length === volume.data.length) throw new Error('Output must have a nonempty bounded support mask.');
  const mean = positive.reduce((sum, value) => sum + value, 0) / positive.length;
  if (Math.abs(mean - 700) > 0.01) throw new Error('Output intensity normalization failed.');
  const spacing = [0,1,2].map(axis => Math.hypot(...volume.affine.slice(0,3).map(row => row[axis])));
  if (spacing.some(value => Math.abs(value - 0.8) > 1e-5)) throw new Error('Unexpected output geometry.');
  return { dims: volume.dims, affine: volume.affine, spacing, supportedVoxels: positive.length, mean };
}

export async function runBrowserValidation({ url, reportDirectory, thicknesses, timeout = 4 * 60 * 60 * 1000 }) {
  if (!url || !reportDirectory || !process.env.TMPDIR) throw new Error('Set NESVOR_BROWSER_URL, NESVOR_REPORT_DIR and TMPDIR. Serve a fresh production build first.');
  await mkdir(resolve(reportDirectory), { recursive: true });
  const reportPath = await realpath(resolve(reportDirectory));
  if (!relative(await realpath(root), reportPath).startsWith('..')) throw new Error('Validation artifacts belong outside the source repository.');
  if (![1,6].includes(thicknesses?.length) || thicknesses.some(value => !Number.isFinite(value) || value <= 0 || value > 20)) throw new Error('Set NESVOR_EXAMPLE_THICKNESSES_MM to one or six confirmed physical thicknesses.');
  await mkdir(reportPath, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-webgpu'] });
  const started = Date.now();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(url);
    const adapter = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const info = adapter.info;
      return { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, fallback: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? false };
    });
    requireHardwareAdapter(adapter);
    const [example] = JSON.parse(await readFile(join(root, 'apps/nesvor/examples.json')));
    const lock = JSON.parse(await readFile(join(root, 'registry/offline-assets.lock.json')));
    const inputs = [];
    const cache = join(process.env.TMPDIR, 'nesvor-real-example-cache');
    await mkdir(cache, { recursive: true });
    for (const entry of example.files.filter(entry => entry.role === 'stack')) {
      const bytes = await cachedAsset(entry, lock.assets[entry.url], cache);
      inputs.push({ name: entry.name, mimeType: 'application/octet-stream', buffer: bytes });
    }
    if (inputs.length !== 6) throw new Error('The full six-stack pinned acquisition is required.');
    const uploads = [];
    page.on('request', request => {
      if (['POST','PUT','PATCH'].includes(request.method()) && !new URL(request.url()).hostname.endsWith('google-analytics.com')) uploads.push(request.url());
    });
    await page.locator('#executionMode').selectOption('browser-webgpu');
    await page.locator('#imageInput').setInputFiles(inputs);
    await expect(page.locator('#stackRows [data-stack]')).toHaveCount(6);
    await page.locator('#protocol').selectOption('fetal-brain');
    for (let i = 0; i < 6; i++) await page.locator(`#thickness-${i}`).fill(String(thicknesses[thicknesses.length === 1 ? 0 : i]));
    await page.locator('#runButton').click();
    await page.waitForFunction(() => {
      const status = document.querySelector('#statusText');
      return status.classList.contains('error') || status.textContent.includes('Browser WebGPU output ready');
    }, null, { timeout });
    if (await page.locator('#statusText').evaluate(node => node.classList.contains('error'))) throw new Error(await page.locator('#statusText').textContent());
    const downloads = [];
    for (let i = 0; i < 3; i++) {
      const pending = page.waitForEvent('download');
      await page.locator('#resultList button:has-text("Download")').nth(i).click();
      const item = await pending;
      const path = join(reportPath, item.suggestedFilename());
      await item.saveAs(path);
      downloads.push(await readFile(path));
    }
    const provenance = JSON.parse(downloads[1]);
    const output = validateBrowserOutput(downloads[0], provenance);
    if (uploads.length) throw new Error('Browser processing made an unexpected upload request.');
    await expect(page.locator('#viewerError')).toBeHidden();
    await page.screenshot({ path: join(reportPath, 'browser-reconstruction.png'), fullPage: true });
    const report = { completed: true, adapter, browser: browser.version(), elapsedSeconds: (Date.now() - started) / 1000, sourceExample: example.id, inputDigests: example.files.map(file => lock.assets[file.url].sha256), thicknesses, output, provenance, cudaParity: false, clinicalValidation: false };
    await writeFile(join(reportPath, 'browser-report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runBrowserValidation({ url: process.env.NESVOR_BROWSER_URL, reportDirectory: process.env.NESVOR_REPORT_DIR, thicknesses: (process.env.NESVOR_EXAMPLE_THICKNESSES_MM ?? '').split(',').map(Number) });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

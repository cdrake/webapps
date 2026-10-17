import { chromium } from 'playwright';
import fs from 'node:fs';
const D = '/storage/calmar-dwi-models/parity/Subject01';
const OUT = '/storage/calmar-dwi-models/browser-b0';
const browser = await chromium.launch();
const page = await browser.newPage();
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
page.on('console', msg => { const t = msg.text(); if (/DeepISLES|SynthStrip|Error|error|pass \d+\/|seed|Prealign/.test(t)) fs.appendFileSync(`${OUT}/console.log`, `${stamp()} ${t}\n`); });
page.on('pageerror', e => fs.appendFileSync(`${OUT}/console.log`, `${stamp()} PAGEERROR ${e.message}\n`));
await page.goto(process.argv[2]);
await page.waitForFunction(() => window.app?.executor, null, { timeout: 60000 });
await page.setInputFiles('#deepIslesDwiFileInput', `${D}/dwi.nii.gz`);
await page.setInputFiles('#deepIslesB0FileInput', `${D}/b0.nii.gz`);
await page.waitForTimeout(3000);
await page.click('#runFullPipelineButton');
const deadline = Date.now() + 110 * 60 * 1000;
let last = '';
while (Date.now() < deadline) {
  const state = await page.evaluate(() => ({
    review: !!app.maskReviewActive,
    seed: !!app.autoLesionSeedFile,
    status: document.getElementById('statusText')?.textContent,
    error: document.getElementById('statusText')?.classList.contains('error')
  }));
  if (state.status !== last) { fs.appendFileSync(`${OUT}/status.log`, `${stamp()} ${state.status}\n`); last = state.status; }
  if (state.review || state.error) break;
  await page.waitForTimeout(5000);
}
const seed = await page.evaluate(async () => {
  const f = app.autoLesionSeedFile;
  if (!f) return null;
  return Array.from(new Uint8Array(await f.arrayBuffer()));
});
if (seed) fs.writeFileSync(`${OUT}/seed.nii`, Buffer.from(seed));
const log = await page.evaluate(() => document.getElementById('technicalConsoleOutput')?.innerText || '');
fs.writeFileSync(`${OUT}/technical.log`, log);
await page.screenshot({ path: `${OUT}/review.png` });
console.log('done', stamp(), seed ? seed.length : 'no seed');
await browser.close();

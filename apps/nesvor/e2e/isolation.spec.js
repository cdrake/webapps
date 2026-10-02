import { test, expect } from '@playwright/test';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveSite } from '../../../test-utils/serve-site.mjs';

test('static hosting without COOP/COEP headers becomes isolated for N4', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'nesvor-headerless-'));
  await symlink(fileURLToPath(new URL('../dist', import.meta.url)), join(root, 'nesvor'), 'junction');
  const server = await serveSite(root, { isolationHeaders: false });
  try {
    const response = await page.goto(`${server.origin}/nesvor/`);
    expect(response.headers()['cross-origin-opener-policy']).toBeUndefined();
    await page.waitForFunction(() => self.crossOriginIsolated, null, { timeout: 30000 });
    expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
    await expect(page.locator('#executionMode')).toHaveValue('browser-webgpu');
    expect(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toBe(`${server.origin}/nesvor/coi-serviceworker.js`);
  } finally {
    await page.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

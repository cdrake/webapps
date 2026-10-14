import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const catalog = JSON.parse(await readFile(new URL('../registry/standalone.json', import.meta.url)));

export async function verifyStandaloneDialog(page, id) {
  await page.locator('[data-neurodesk-shell-control="standalone"]:visible').first().click();
  const dialog = page.locator('#neurodeskStandaloneDialog');
  await expect(dialog).toBeVisible();
  for (const download of catalog.apps[id].downloads) {
    await expect(dialog.locator(`a[href="${download.url}"]`)).toBeVisible();
    await expect(dialog).not.toContainText(download.sha256);
  }
  // The dialog lists the app's own command line, never the all-apps desktop suite.
  await expect(dialog.locator('a[href*="/releases/download/webapps-v"]')).toHaveCount(0);
  await expect(dialog).not.toContainText(/SHA-256|shasum|Prepare this upstream/i);
  await expect(dialog).not.toContainText('cargo build');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}

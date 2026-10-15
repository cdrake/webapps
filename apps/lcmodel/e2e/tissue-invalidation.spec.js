import { test, expect } from "@playwright/test";
import { forceCpu, proxyAssets, REPLACEMENT_TIMEOUT } from "./tissue-runtime.mjs";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";

const EXAMPLE = "philips-press-t1";

async function loadExample(page) {
  await proxyAssets(page);
  await forceCpu(page);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(EXAMPLE);
  await expect(page.locator("#t1Info")).toContainText("256 × 256 × 204", { timeout: 300000 });
  await expect(page.locator("#t1Canvas")).toBeVisible();
  await expect(page.locator("#viewerNotice")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 300000 });
  await expect(page.locator("#tissueSection")).toHaveAttribute("open", "");
  await expect(page.locator("#measureButton")).toBeEnabled();
}

for (const input of ["#dataInput", "#t1Input"]) {
  test(`${input} clears correction before rendering with synthetic tissue maps`, async ({ page }) => {
    test.setTimeout(400000);
    await page.context().route(/\/tissue-worker-[^/]+\.js$/, async (route) => route.fulfill({
      response: await route.fetch(),
      contentType: "text/javascript",
      body: `self.onmessage = ({data: {input}}) => {
        const tissues = {};
        for (const [key, fraction] of Object.entries({gm: 0.6, wm: 0.3, csf: 0.1})) {
          const header = new DataView(input);
          const count = header.getInt16(42, true) * header.getInt16(44, true) * header.getInt16(46, true);
          tissues[key] = new ArrayBuffer(352 + count * 4);
          new Uint8Array(tissues[key], 0, 348).set(new Uint8Array(input, 0, 348));
          const output = new DataView(tissues[key]);
          output.setInt16(70, 16, true);
          output.setInt16(72, 32, true);
          output.setFloat32(108, 352, true);
          output.setFloat32(112, 1, true);
          output.setFloat32(116, 0, true);
          new Float32Array(tissues[key], 352).fill(fraction);
        }
        self.postMessage({result: {tissues, backend: "cpu", elapsedMs: 1}});
      };`,
    }));

    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        if (message.url instanceof File && message.url.name === "replacement.nii") {
          window.replacementViewerHeld = true;
          window.releaseReplacementViewer = () => original.call(this, message, ...args);
          return;
        }
        return original.call(this, message, ...args);
      };
    });
    await loadExample(page);
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 300000 });
    await expect(page.locator("#corrHeader")).toBeVisible();
    await expect(page.locator('#resultList [data-stage="gmMap"]')).toHaveCount(1);
    await expect(page.locator(input)).toBeEnabled();
    await page.locator(input).setInputFiles({
      name: "replacement.nii", mimeType: "application/octet-stream",
      buffer: syntheticNifti({ dims: [32, 32, 32], gzip: false }),
    });
    await expect(page.locator("#t1Info")).toContainText("replacement.nii", { timeout: REPLACEMENT_TIMEOUT });
    await expect(page.locator("#fGm")).toHaveValue("");
    await expect.poll(() => page.evaluate(() => window.replacementViewerHeld), { timeout: 120000 }).toBe(true);
    try {
      await expect(page.locator("#corrHeader")).toBeHidden();
      await expect(page.locator('#resultList [data-stage="gmMap"]')).toHaveCount(0);
    } finally {
      await page.evaluate(() => window.releaseReplacementViewer());
    }
  });
}

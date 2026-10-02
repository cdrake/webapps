import { test, expect } from "@playwright/test";
import { writeVolume, readVolume } from "@neurodesk/synthsr";
import { readFile } from "node:fs/promises";

test("lesion probability colors lesions without tinting the background", async ({ page }, testInfo) => {
  const dims = [32, 32, 32];
  const affine = [[1, 0, 0, -16], [0, 1, 0, -16], [0, 0, 1, -16], [0, 0, 0, 1]];
  const flair = new Float32Array(32 ** 3);
  const probability = new Float32Array(flair.length);
  for (let z = 4; z < 28; z++) {
    for (let y = 4; y < 28; y++) {
      for (let x = 4; x < 28; x++) {
        const i = x + 32 * (y + 32 * z);
        flair[i] = 100 + x;
        probability[i] = x >= 14 && x < 18 && y >= 14 && y < 18 && z >= 14 && z < 18 ? 0.9 : 0.01;
      }
    }
  }
  const volume = (data) => Buffer.from(writeVolume({ dims, affine, data }));
  const probabilityBytes = volume(probability);
  // Supply deterministic worker results; use the real output controls and NiiVue renderer.
  await page.route(/\/worker-[^/]+\.js$/, (route) => route.fulfill({
    contentType: "text/javascript",
    headers: { "cross-origin-embedder-policy": "require-corp" },
    body: `self.onmessage = () => self.postMessage({
      type: "result",
      mask: new Uint8Array(${JSON.stringify([...volume(Uint8Array.from(probability, (p) => p > 0.5))])}).buffer,
      probability: new Uint8Array(${JSON.stringify([...probabilityBytes])}).buffer,
      tsv: "lesion\\tvoxels\\n1\\t64\\n",
      summary: { count: 1, totalMl: 0.064 }, provenance: {}
    });`,
  }));
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles({ name: "flair.nii", mimeType: "application/octet-stream", buffer: volume(flair) });
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Segmentation complete");
  const probabilityRow = page.locator("#resultList .nd-volume-toggle").filter({ hasText: "Lesion probability" });
  await probabilityRow.getByRole("button", { name: "View", exact: true }).click();
  await expect(probabilityRow.locator(".nd-view-btn")).toHaveClass(/active/);
  for (const layout of ["Axial", "3-Plane"]) {
    await page.getByRole("button", { name: layout, exact: true }).click();
    const screenshot = await page.locator("#gl1").screenshot();
    await testInfo.attach(`probability-${layout}`, { body: screenshot, contentType: "image/png" });
    const coloredFraction = await page.evaluate(async (base64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let colored = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > data[i + 2] + 30 && data[i + 1] > data[i + 2] + 20) colored++;
      }
      return colored / (canvas.width * canvas.height);
    }, screenshot.toString("base64"));
    expect(coloredFraction, "lesions remain visible").toBeGreaterThan(0.001);
    expect(coloredFraction, "background remains transparent").toBeLessThan(0.1);
  }
  const pending = page.waitForEvent("download");
  await probabilityRow.getByRole("button", { name: "Download", exact: true }).click();
  const downloaded = await readFile(await (await pending).path());
  const output = readVolume(downloaded.buffer.slice(downloaded.byteOffset, downloaded.byteOffset + downloaded.byteLength));
  expect(output.data).toEqual(probability);
  await page.screenshot({ path: testInfo.outputPath("probability-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("probability-phone.png"), fullPage: true });
});

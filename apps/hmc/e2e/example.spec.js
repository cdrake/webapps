import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fetchPinnedExample } from "../../../test-utils/registration-similarity.mjs";
import { fixture } from "./fixtures.mjs";

const [example] = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

test("a failed example download can retry the same selection", async ({ page }) => {
  const files = new Map(await Promise.all(example.files.map(async file => [file.url, await fetchPinnedExample(file.url)])));
  let fail = true;
  await page.route("**/*", route => {
    const bytes = files.get(route.request().url());
    if (!bytes) return route.continue();
    if (fail && route.request().url() === example.files[0].url) {
      fail = false;
      return route.fulfill({ status: 503, body: "", headers: { "access-control-allow-origin": "*" } });
    }
    return route.fulfill({ body: bytes, headers: { "access-control-allow-origin": "*" } });
  });
  await page.goto("./");
  const selector = page.locator("select[data-neurodesk-example]");
  await selector.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
  await expect(page.locator("#runButton")).toBeDisabled();
  await selector.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#fileInfo")).toContainText(example.files[0].name);
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a registration leaves the loaded input available for retry", async ({ page }) => {
  test.setTimeout(60000);
  const data = await fixture();
  const stem = "sub-test_dwi";
  const payload = (name, bytes) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(bytes) });
  await page.goto("./");
  await page.locator("#imageInput").setInputFiles([
    payload(`${stem}.nii`, data.nifti), payload(`${stem}.bval`, data.bvals.join(" ")),
    payload(`${stem}.bvec`, data.bvecs.map(row => row.join(" ")).join("\n")),
  ]);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#advancedSettings > summary").click();
  await page.locator("#maskInput").setInputFiles(payload("mask.nii", data.maskNifti));
  await expect(page.locator("#statusText")).toHaveText("Brain mask loaded");
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    window.hmcHeld = 0;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message.argv) { window.hmcHeld++; return; }
      return send.call(this, message, ...rest);
    };
    window.restoreHmcWorkers = () => { Worker.prototype.postMessage = send; };
  });
  await page.locator("#runButton").click();
  await page.waitForFunction(() => window.hmcHeld > 0);
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#fileInfo")).toContainText(stem);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => window.restoreHmcWorkers());
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Head motion corrected", { timeout: 30000 });
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: "sidecar" }).getByRole("button", { name: "Download" }).click();
  const metadata = JSON.parse(await readFile(await (await pending).path(), "utf8"));
  expect(metadata.HeadMotionCorrection.Mask.Source).toBe("supplied");
  await page.locator("#clearMask").click();
  await expect(page.locator("#clearMask")).toBeHidden();
  await expect(page.locator("#maskField .nd-file-text")).toHaveText("Drop a brain mask");
});

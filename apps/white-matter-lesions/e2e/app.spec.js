import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readVolume } from "@neurodesk/synthsr";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
const manifest = JSON.parse(await readFile(new URL("../../../models/white-matter-lesions.manifest.json", import.meta.url), "utf8"));
const modelUrl = manifest.base_url + manifest.assets[0].filename;
const bytesOf = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

async function download(page, index) {
  const pending = page.waitForEvent("download");
  await page.locator("#resultList .nd-download-btn").nth(index).click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

test("the MS example is segmented into lesions on the input grid, falling back from a failed WebGPU", async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  // The page sees an adapter, so Automatic picks WebGPU; the worker has none, so its session fails.
  await page.addInitScript(() => {
    if (navigator.gpu) navigator.gpu.requestAdapter = async () => ({});
  });
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
  await expect(page.locator("#fileInfo")).toContainText("240 × 240 × 81 voxels");
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText(/^Segmentation complete · \d+ lesions · [\d.]+ ml$/, { timeout: 18 * 60 * 1000 });
  await expect(page.locator("#cancelButton")).toBeHidden();
  const [, count, ml] = (await page.locator("#statusText").textContent()).match(/(\d+) lesions · ([\d.]+) ml/);
  expect(Number(count)).toBeGreaterThan(5);
  expect(Number(ml)).toBeGreaterThan(5);
  await expect(page.locator("#technicalLog")).toContainText("continuing on the CPU");
  await expect(page.locator("#technicalLog")).toContainText("FLAMeS on WebAssembly");
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
  await expect(page.locator("#resultList .nd-view-btn").nth(3)).toBeDisabled();
  const flair = await download(page, 0);
  const mask = await download(page, 1);
  const table = await download(page, 3);
  expect(mask.name).toBe("MSLesSeg_P57_T1_FLAIR_lesions.nii");
  const input = readVolume(bytesOf(flair.bytes));
  const lesions = readVolume(bytesOf(mask.bytes));
  expect(lesions.dims).toEqual(input.dims);
  expect(lesions.affine).toEqual(input.affine);
  const voxels = lesions.data.reduce((sum, v) => sum + v, 0);
  const rows = table.bytes.toString().trim().split("\n");
  expect(rows[0]).toBe("lesion\tvoxels\tvolume_ml\tx_mm\ty_mm\tz_mm");
  expect(rows.length - 1).toBe(Number(count));
  expect(rows.slice(1).reduce((sum, row) => sum + Number(row.split("\t")[1]), 0)).toBe(voxels);
});

test("a failed model download reports the error and leaves the run available", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.route(modelUrl, (route) => route.fulfill({ status: 503, body: "" }));
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings summary").click();
  await page.locator("#skullStripped").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\)/, { timeout: 120000 });
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(1);
});

test("the ensemble downloads each fold in turn", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  const secondFold = manifest.base_url + manifest.assets[1].filename;
  await page.route(secondFold, (route) => route.fulfill({ status: 503, body: "" }));
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings summary").click();
  await page.locator("#skullStripped").check();
  await page.locator("#folds").selectOption("5");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText(/Model download failed \(503\): .*flames-fold1\.onnx/, { timeout: 180000 });
  await expect(page.locator("#technicalLog")).toContainText("Downloading FLAMeS model 1 of 5…");
  await expect(page.locator("#technicalLog")).toContainText("Downloading FLAMeS model 2 of 5…");
  await expect(page.locator("#runButton")).toBeEnabled();
});

test("cancelling a run stops it and keeps the input ready", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);
  await page.route(modelUrl, () => {});
  await page.goto("./");
  await page.getByLabel("Example", { exact: true }).selectOption(examples[0].id);
  await expect(page.locator("#runButton")).toBeEnabled({ timeout: 120000 });
  await page.locator("#advancedSettings summary").click();
  await page.locator("#skullStripped").check();
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Downloading FLAMeS model…", { timeout: 60000 });
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#cancelButton")).toBeHidden();
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#fileInfo")).toContainText("MSLesSeg_P57_T1_FLAIR.nii.gz");
});

test("advanced settings keep their values when the section closes", async ({ page }) => {
  await page.goto("./");
  const summary = page.locator("#advancedSettings summary");
  await summary.click();
  await page.locator("#skullStripped").check();
  await page.locator("#backend").selectOption("wasm");
  await page.locator("#folds").selectOption("5");
  await summary.click();
  await summary.click();
  await expect(page.locator("#skullStripped")).toBeChecked();
  await expect(page.locator("#folds")).toHaveValue("5");
  await expect(page.locator("#backend")).toHaveValue("wasm");
});

for (const failure of ["download", "empty image"]) {
  test(`a failed example ${failure} can be retried`, async ({ page }) => {
    const example = examples[0];
    let attempts = 0;
    await page.route(example.files[0].url, (route) => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
      return route.continue();
    });
    await page.goto("./");
    const picker = page.getByLabel("Example", { exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("the shared app bar owns About, Cite and the theme", async ({ page }) => {
  await page.goto("./");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("FLAMeS");
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.getByRole("button", { name: "Cite", exact: true }).click();
  await expect(page.locator("dialog[open]").last()).toContainText("10.1101/2025.05.19.25327707");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

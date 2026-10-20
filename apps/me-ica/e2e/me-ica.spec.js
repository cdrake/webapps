// Real browser tests against the built app (vite preview): cross-origin isolation, the
// WebAssembly worker (single-threaded, as @niivue/meica ships), the example through denoising, downloads and automation. Outputs must be
// byte-identical to the native me-ica CLI (e2e/expected.json, recorded from `me-ica` on the
// example). ME_ICA_EXAMPLE_DIR serves the example from a local copy instead of Hugging Face.
import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const example = examples[0];
const local = process.env.ME_ICA_EXAMPLE_DIR;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function exampleBytes(file) {
  if (local) return readFileSync(join(local, file.name));
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Example files on disk (Playwright refuses in-memory uploads over 50 MB). */
async function examplePaths(role) {
  const files = example.files.filter((f) => f.role === role);
  if (local) return files.map((f) => join(local, f.name));
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "me-ica-example-"));
  return Promise.all(files.map(async (f) => {
    const path = join(dir, f.name);
    writeFileSync(path, await exampleBytes(f));
    return path;
  }));
}

async function serveExample(page) {
  if (!local) return;
  for (const file of example.files) await page.route(file.url, (route) => route.fulfill({ body: readFileSync(join(local, file.name)) }));
}

async function loadExample(page) {
  await serveExample(page);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(example.id);
  await expect(page.locator("#fileInfo")).toContainText("3 echoes", { timeout: 180000 });
  await expect(page.locator("#echoTimes")).toHaveValue("15.2 35.32 55.42");
  await expect(page.locator("#runButton")).toBeEnabled();
}

async function downloaded(page, click) {
  const promise = page.waitForEvent("download");
  await click();
  const download = await promise;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

test("app boots cross-origin isolated with the shared app bar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
});

test("the example denoises to tedana's result, byte-identical to the native CLI", async ({ page }) => {
  test.setTimeout(600000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("13 components, 7 accepted, 6 rejected", { timeout: 300000 });
  const list = page.locator("#resultList");
  for (const [label, name] of [["Denoised series", "desc-denoised_bold.nii.gz"], ["Optimally combined series", "desc-optcom_bold.nii.gz"], ["T2* map (s)", "T2starmap.nii.gz"], ["Component metrics (table)", "desc-tedana_metrics.tsv"]]) {
    const row = list.locator(".nd-volume-toggle", { hasText: label });
    const file = await downloaded(page, () => row.getByRole("button", { name: "Download", exact: true }).click());
    expect(file.name).toBe(name);
    expect(sha(file.bytes), name).toBe(expected.sha256[name]);
  }
  await page.locator('[data-view="components"]').click();
  const rows = page.locator("#componentReport tbody tr");
  await expect(rows).toHaveCount(13);
  await rows.nth(2).click();
  await expect(page.locator("#imageLabel")).toContainText("ICA_02 map");
  await expect(page.locator("#componentReport")).toBeHidden();
  const zip = await downloaded(page, () => page.locator("#zipButton").click());
  expect(zip.name).toBe("me-ica_outputs.zip");
  expect(zip.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(zip.bytes.includes(Buffer.from("desc-tedana_registry.json"))).toBe(true);
});

test("the motion-corrected example with its confounds runs the motion_aroma tree as tedana does", async ({ page }) => {
  test.setTimeout(600000);
  const want = expected.motion_aroma;
  const moco = examples.find((e) => e.id === want.example);
  await page.goto("/");
  await page.locator("select[data-neurodesk-example]").selectOption(moco.id);
  await expect(page.locator("#fileInfo")).toContainText("regressors sub-01_task-motor_desc-confounds_timeseries.tsv", { timeout: 180000 });
  await page.locator("#tree").selectOption("motion_aroma");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("13 components, 1 accepted, 12 rejected", { timeout: 300000 });
  const list = page.locator("#resultList");
  for (const [label, name] of [["Denoised series", "desc-denoised_bold.nii.gz"], ["Component metrics (table)", "desc-tedana_metrics.tsv"]]) {
    const file = await downloaded(page, () => list.locator(".nd-volume-toggle", { hasText: label }).getByRole("button", { name: "Download", exact: true }).click());
    expect(sha(file.bytes), name).toBe(want.sha256[name]);
  }
});

test("a regressor tree without a confounds TSV explains what is missing", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await page.locator("#tree").selectOption("motion_f");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("needs a regressors TSV");
});

test("cancelling a run stops the worker and allows a new run", async ({ page }) => {
  test.setTimeout(300000);
  await loadExample(page);
  await page.locator("#runButton").click();
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#outputSection")).not.toHaveAttribute("open", "");
});

test("a failed example download can retry", async ({ page }) => {
  let attempts = 0;
  for (const file of example.files) {
    await page.route(file.url, (route) => {
      if (file === example.files[0]) attempts++;
      if (file === example.files[0] && attempts === 1) return route.fulfill({ status: 503, body: "" });
      return local ? route.fulfill({ body: readFileSync(join(local, file.name)) }) : route.continue();
    });
  }
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error", { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
  await expect(page.locator("#runButton")).toBeEnabled();
  expect(attempts).toBe(2);
});

test("cancelling an example download leaves no inputs and permits retry", async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  await page.route(example.files[0].url, async (route) => {
    await gate;
    return local ? route.fulfill({ body: readFileSync(join(local, example.files[0].name)) }) : route.continue();
  });
  for (const file of example.files.slice(1)) await page.route(file.url, (route) => (local ? route.fulfill({ body: readFileSync(join(local, file.name)) }) : route.continue()));
  await page.goto("/");
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  release();
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 180000 });
});

test("automation denoises declared echoes and sidecars", async ({ page }) => {
  test.setTimeout(600000);
  await page.goto("/");
  for (const [role, files] of [["echoes", await examplePaths("echo")], ["sidecars", await examplePaths("metadata")]]) {
    await page.locator("#neurodesk-input-transfer").setInputFiles(files);
    await page.evaluate((r) => globalThis.neurodeskAutomation.dispatch("adopt", { role: r }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", {}));
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 300000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.measurements).toMatchObject(expected.summary);
  expect(report.artifacts.denoised.sha256).toBe(expected.sha256["desc-denoised_bold.nii.gz"]);
  expect(report.artifacts.metrics.sha256).toBe(expected.sha256["desc-tedana_metrics.tsv"]);
});

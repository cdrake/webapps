// Real browser smoke test. Runs against `vite preview` (see playwright.config.js):
// the built page, its NeuroFlow bundle and the vendored validator WebAssembly.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const shipped = JSON.parse(readFileSync(new URL("../workflows/n4-extract-synthseg.workflow.json", import.meta.url), "utf8"));

test("app boots with the tool catalog", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#statusText")).toHaveText(/^\d+ tools from \d+ apps · add a step to start a workflow$/, { timeout: 30000 });
  await expect(page.locator("#toolSelect option")).not.toHaveCount(0);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("a shipped workflow loads, validates and exports unchanged", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#library")).toBeEnabled({ timeout: 30000 });
  await page.getByLabel("Start from").selectOption({ label: shipped.description });
  await expect(page.locator("#statusText")).toHaveText("Valid workflow · 3 steps", { timeout: 30000 });
  await expect(page.locator("#stepList > section")).toHaveCount(3);
  const download = page.waitForEvent("download");
  await page.locator("#runButton").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("n4-extract-synthseg.workflow.json");
  expect(JSON.parse(readFileSync(await file.path(), "utf8"))).toEqual(shipped);
});

test("an opened workflow file replaces the document", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#library")).toBeEnabled({ timeout: 30000 });
  await page.locator("#workflowInput").setInputFiles({ name: "mine.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...shipped, id: "neurodesk.webapps/pipelines/mine" })) });
  await expect(page.locator("#statusText")).toHaveText("Valid workflow · 3 steps", { timeout: 30000 });
  await expect(page.locator("#workflowId")).toHaveValue("neurodesk.webapps/pipelines/mine");
  await page.locator("#workflowInput").setInputFiles({ name: "tool.json", mimeType: "application/json", buffer: Buffer.from('{"kind":"tool"}') });
  await expect(page.locator("#statusText")).toHaveText("Not a NeuroFlow workflow document");
});

test("adding steps chains them, and an unbound input blocks export", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled({ timeout: 30000 });
  for (const id of ["neurodesk.webapps/n4/correct", "neurodesk.webapps/brain-extraction/extract"]) {
    await page.locator("#toolSelect").selectOption(id);
    await page.locator("#addStep").click();
  }
  await expect(page.locator("#statusText")).toHaveText("Valid workflow · 2 steps", { timeout: 30000 });
  const binding = page.locator('#stepList select[data-step="extract"][data-binding="input_image"]');
  await expect(binding).toHaveValue("steps.correct.outputs.output_image");
  // The picker offers only type-compatible sources; an unbound required input is the error left.
  await expect(binding.locator('option[value="steps.correct.outputs.report"]')).toHaveCount(0);
  await binding.selectOption("");
  await expect(page.locator("#statusText")).toHaveText(/to fix before export/, { timeout: 30000 });
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the automation operation returns the validator's report", async ({ page }) => {
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "pipeline.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(shipped)) });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "workflow" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 30000 }).toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance).toMatchObject({ valid: true, scientificProcessing: false });
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "validation" }));
  expect(JSON.parse(readFileSync(await (await download).path(), "utf8")).ok).toBe(true);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
  await expect(page.locator("#controls > #aboutBtn")).toBeHidden();
  await bar.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toBeVisible();
  await page.locator("#infoDialog").getByRole("button", { name: "Close" }).click();
  await bar.locator("[data-neurodesk-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-neurodesk-theme", "light");
});

test("page is cross-origin isolated (COOP/COEP active)", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => self.crossOriginIsolated === true)).toBe(true);
});

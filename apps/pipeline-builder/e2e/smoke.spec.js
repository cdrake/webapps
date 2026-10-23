import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const [example] = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const exampleUrl = example.files[0].url;
const template = JSON.parse(readFileSync(new URL("../src/workflows/t1-segmentation.workflow.json", import.meta.url), "utf8"));

async function chooseExample(page) {
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.getByRole("combobox", { name: "Input", exact: true }).selectOption(example.id);
}

async function exported(page) {
  const download = page.waitForEvent("download");
  await page.locator("#runButton").click();
  return JSON.parse(readFileSync(await (await download).path(), "utf8"));
}

test("app boots with the catalog ready", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#statusText")).toContainText("operations from the Neurodesk catalog");
  await expect(page.locator("#toolSelect option[value='neurodesk.webapps/n4/correct']")).toHaveCount(1);
  await expect(page.locator("#toolSelect option[value^='neurodesk.webapps/pipeline-builder/']")).toHaveCount(0);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the page publishes a NeuroFlow registry beside itself", async ({ page }) => {
  await page.goto("/");
  const index = await page.evaluate(async () => (await fetch("neuroflow/neuroflow-registry.json")).json());
  expect(index.kind).toBe("neuroflow/registry-index");
  expect(index.workflows).toEqual(["workflows/t1-segmentation.workflow.json"]);
  const statuses = await page.evaluate(paths => Promise.all(paths.map(async path => (await fetch(`neuroflow/${path}`)).status)), [...index.tools.slice(0, 3), "scripts/neurodesk.mjs"]);
  expect(statuses).toEqual([200, 200, 200, 200]);
});

test("the hosted example is the shipped template and exports unchanged", async ({ page }) => {
  await page.goto("/");
  await chooseExample(page);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#fileInfo")).toHaveText("t1-segmentation.workflow.json");
  await expect(page.locator("#stepRows tr")).toHaveCount(3);
  await expect(page.locator("#validationSummary")).toHaveText("Valid · 3 steps.");
  const download = page.waitForEvent("download");
  await page.locator("#runButton").click();
  expect((await download).suggestedFilename()).toBe("t1-segmentation.workflow.json");
  expect(JSON.parse(readFileSync(await (await download).path(), "utf8"))).toEqual(template);
});

for (const [failure, response, message] of [
  ["download", { status: 503, body: "" }, "Could not download t1-segmentation.workflow.json (HTTP 503)."],
  ["checksum", { status: 200, body: " ".repeat(example.files[0].bytes) }, "The checksum for t1-segmentation.workflow.json did not match."],
]) {
  test(`a failed example ${failure} opens nothing and can retry`, async ({ page }) => {
    let attempts = 0;
    await page.context().route(exampleUrl, route => (++attempts > 1 ? route.fallback() : route.fulfill(response)));
    await page.goto("/");
    await chooseExample(page);
    const selector = page.locator("[data-neurodesk-examples]");
    await expect(selector).toHaveAttribute("data-example-state", "error");
    await expect(selector).toContainText(message);
    await expect(page.locator("#stepRows tr")).toHaveCount(0);
    await expect(page.locator("#runButton")).toBeDisabled();
    await chooseExample(page);
    await expect(selector).toHaveAttribute("data-example-state", "ready");
    await expect(page.locator("#validationSummary")).toHaveText("Valid · 3 steps.");
    expect(attempts).toBe(2);
  });
}

test("cancelling the example download opens nothing and permits a retry", async ({ page }) => {
  let attempts = 0;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.context().route(exampleUrl, async route => {
    if (++attempts > 1) return route.fallback();
    await held;
    return route.fulfill({ body: JSON.stringify(template) }).catch(() => {});
  });
  await page.goto("/");
  await chooseExample(page);
  const selector = page.locator("[data-neurodesk-examples]");
  await expect(selector).toHaveAttribute("data-example-state", "loading");
  await expect.poll(() => attempts).toBe(1);
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await expect(selector).toHaveAttribute("data-example-state", "cancelled");
  release();
  await expect(page.locator("#stepRows tr")).toHaveCount(0);
  await expect(page.locator("#fileInfo")).toBeHidden();
  await chooseExample(page);
  await expect(selector).toHaveAttribute("data-example-state", "ready");
  await expect(page.locator("#stepRows tr")).toHaveCount(3);
});

test("steps chain by compatible outputs and the export validates", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.locator("#toolSelect").selectOption("neurodesk.webapps/n4/correct");
  await page.locator("#addStepButton").click();
  await page.locator("#toolSelect").selectOption("neurodesk.webapps/brain-extraction/extract");
  await page.locator("#addStepButton").click();
  // brain-extraction was bound to N4's corrected image, the output named like its input.
  const source = page.locator("#bind-input_image");
  await expect(source).toHaveValue("steps.n4.outputs.output_image");
  await expect(source.locator("option[value='steps.n4.outputs.report']")).toHaveCount(0);
  await page.getByLabel("Workflow output: brain").check();
  await expect(page.locator("#validationSummary")).toHaveText("1 problem to fix before export. Workflow description is required.");
  await page.locator("#workflowId").fill("lab.pipelines/strip");
  await page.locator("#workflowDescription").fill("Bias-correct and skull-strip a head MRI.");
  await page.locator("#workflowDescription").press("Tab");
  await expect(page.locator("#validationSummary")).toHaveText("Valid · 2 steps.");
  const doc = await exported(page);
  expect(doc.neuroflow).toBe("0.1.1");
  expect(doc.id).toBe("lab.pipelines/strip");
  expect(doc.description).toBe("Bias-correct and skull-strip a head MRI.");
  expect(Object.keys(doc.steps)).toEqual(["n4", "brain-extraction"]);
  expect(doc.steps.n4.inputs.input_image).toEqual({ ref: "inputs.image" });
  expect(doc.outputs.brain).toEqual({ type: "neuro:volume", ref: "steps.brain-extraction.outputs.output_brain" });
});

test("an invalid workflow opens with its problems and cannot be exported", async ({ page }) => {
  const broken = structuredClone(template);
  broken.steps.segment.inputs.input_image = { ref: "steps.n4.outputs.report" };
  await page.goto("/");
  await expect(page.locator("#toolSelect")).toBeEnabled();
  await page.locator("#workflowInput").setInputFiles({ name: "broken.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(broken)) });
  await expect(page.locator("#validationSummary")).toHaveText("1 problem to fix before export.");
  await expect(page.locator("#stepRows tr").nth(2)).toContainText("incompatible");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("the automation operation validates a workflow", async ({ page }) => {
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name: "t1.workflow.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(template)) });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "workflow" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state)).toBe("succeeded");
  const download = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "workflow" }));
  expect(JSON.parse(readFileSync(await (await download).path(), "utf8"))).toEqual(template);
});

test("shared app bar owns information actions and theme", async ({ page }) => {
  await page.goto("/");
  const bar = page.locator(".nd-app-bar:visible");
  await expect(bar).toHaveCount(1);
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

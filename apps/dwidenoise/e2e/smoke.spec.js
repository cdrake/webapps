// Browser tests against `vite preview` of the production build: boot, the shared shell,
// Patch2Self in workers against the package's one-pass result, the group and bval refusals,
// gradient pass-through, the hosted example and its failure, retry and cancel paths, and the
// automation operation.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { loadDwidenoise } from "@neurodesk/dwidenoise";
import { dwiSeries } from "./fixtures.mjs";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const imageUrl = examples[0].files.find((file) => file.role === "image").url;
const p2s = await loadDwidenoise(readFileSync(new URL("../../../packages/dwidenoise/src/dwidenoise.wasm", import.meta.url)));

async function download(page, label) {
  const event = page.waitForEvent("download");
  await page.locator("#resultList .nd-volume-toggle").filter({ hasText: label }).getByRole("button", { name: "Download" }).click();
  return event;
}

/** Holds every message to a worker until window.releaseWorkers() is called. */
async function holdWorkers(page) {
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    const held = [];
    Worker.prototype.postMessage = function (...args) {
      held.push([this, args]);
    };
    window.releaseWorkers = () => {
      Worker.prototype.postMessage = send;
      for (const [worker, args] of held.splice(0)) send.apply(worker, args);
    };
  });
}

test("app boots", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewer")).toBeVisible();
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

test("a DWI is denoised in workers as the one-pass port does it, and keeps its gradients", async ({ page }) => {
  const series = dwiSeries();
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(series.files);
  await expect(page.locator("#fileInfo")).toContainText("24×20×4×5 · 1 b0, 4 weighted · bval, bvec");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Denoised 5 volumes", { timeout: 60000 });
  const image = await download(page, "Denoised image");
  expect(image.suggestedFilename()).toBe("sub-01_desc-denoised_dwi.nii.gz");
  const out = readNiftiFrames(gunzipSync(readFileSync(await image.path())));
  expect(out.dims).toEqual([24, 20, 4]);
  expect(out.frames).toBe(5);
  // The single b0 is not fitted and stays as it was.
  expect(Array.from(out.data.subarray(0, series.voxels))).toEqual(Array.from(series.data.subarray(0, series.voxels)));
  // The workers' chunked passes agree with the package's one pass to float32 rounding.
  const expected = p2s.denoiseArray(series.data, series.voxels, [0, 1000, 1000, 1000, 1000]);
  let largest = 0;
  expected.forEach((value, i) => (largest = Math.max(largest, Math.abs(out.data[i] - value))));
  expect(largest).toBeLessThan(1e-3);
  const changed = out.data.subarray(series.voxels).some((v, i) => Math.abs(v - series.data[series.voxels + i]) > 0.5);
  expect(changed).toBe(true);
  const bval = await download(page, "b-values");
  expect(bval.suggestedFilename()).toBe("sub-01_desc-denoised_dwi.bval");
  expect(readFileSync(await bval.path(), "utf8")).toBe("0 1000 1000 1000 1000");
});

test("a DWI without its bvec is denoised and the bval is kept", async ({ page }) => {
  const series = dwiSeries();
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(series.files.slice(0, 2));
  await expect(page.locator("#fileInfo")).toContainText("· bval");
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Denoised 5 volumes", { timeout: 60000 });
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(3);
});

test("a series with fewer than 2 diffusion-weighted volumes is refused", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dwiSeries({ weighted: 1 }).files);
  await expect(page.locator("#statusText")).toHaveText(/at least 2 diffusion-weighted volumes .* This data has 1\./);
  await expect(page.locator("#statusText")).toHaveClass(/error/);
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("an image without a bval is refused", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dwiSeries().files.slice(0, 1));
  await expect(page.locator("#statusText")).toHaveText("Choose the .bval file with sub-01_dwi.nii.gz: Patch2Self groups volumes by b-value.");
  await expect(page.locator("#runButton")).toBeDisabled();
});

test("cancelling stops the workers and permits another run", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dwiSeries().files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await holdWorkers(page);
  const started = page.waitForEvent("worker");
  await page.locator("#runButton").click();
  const worker = await started;
  const stopped = new Promise((resolve) => worker.once("close", resolve));
  await expect(page.locator("#cancelButton")).toBeVisible();
  await page.locator("#cancelButton").click();
  await stopped;
  await page.evaluate(() => window.releaseWorkers());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toHaveText("Denoised 5 volumes", { timeout: 60000 });
});

test("cancelling while packing the image prevents completed outputs", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dwiSeries().files);
  await expect(page.locator("#runButton")).toBeEnabled();
  await page.evaluate(() => {
    const read = Response.prototype.arrayBuffer;
    Response.prototype.arrayBuffer = async function () {
      const buffer = await read.call(this);
      Response.prototype.arrayBuffer = read;
      await new Promise((resolve) => {
        window.finishOutputPacking = resolve;
      });
      return buffer;
    };
  });
  await page.locator("#runButton").click();
  await page.waitForFunction(() => typeof window.finishOutputPacking === "function");
  await page.locator("#cancelButton").click();
  await page.evaluate(() => window.finishOutputPacking());
  await expect(page.locator("#statusText")).toHaveText("Cancelled");
  await expect(page.locator("#runButton")).toBeEnabled();
  await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(0);
});

for (const example of examples) {
  test(`example ${example.id} is denoised and downloads the image and gradients`, async ({ page }) => {
    test.setTimeout(180000);
    await page.goto("/");
    await page.locator("select[data-neurodesk-example]").selectOption(example.id);
    await expect(page.locator("#fileInfo")).toContainText("dwi.nii.gz", { timeout: 120000 });
    await expect(page.locator("#fileInfo")).toContainText("1 b0, 20 weighted · bval, bvec");
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toHaveText("Denoised 21 volumes", { timeout: 120000 });
    await expect(page.locator("#resultList .nd-volume-toggle")).toHaveCount(4);
    const image = await download(page, "Denoised image");
    expect(image.suggestedFilename()).toBe("dwi_desc-denoised.nii.gz");
    const out = readNiftiFrames(gunzipSync(readFileSync(await image.path())));
    expect(out.frames).toBe(21);
    expect(out.data.every(Number.isFinite)).toBe(true);
  });
}

for (const failure of ["download", "empty image"]) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    // The retry downloads the real example, which can take longer than the 30 s default.
    test.setTimeout(150000);
    const example = examples[0];
    let attempts = 0;
    await page.context().route(imageUrl, (route) => {
      attempts++;
      if (attempts > 1) return route.fallback();
      return route.fulfill({ status: failure === "download" ? 503 : 200, body: "" });
    });
    await page.goto("/");
    const picker = page.getByRole("combobox", { name: "Input", exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "error");
    await expect(page.locator("#runButton")).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
    await expect(page.locator("#runButton")).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test("cancelling during image reading prevents a late commit and permits retry", async ({ page }) => {
  test.setTimeout(150000);
  const example = examples[0];
  await page.goto("/");
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole("combobox", { name: "Input", exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === "function", null, { timeout: 120000 });
  await page.getByRole("button", { name: "Cancel example download", exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "cancelled");
  await expect(page.locator("#fileInfo")).toBeHidden();
  await expect(page.locator("#runButton")).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator("[data-neurodesk-examples]")).toHaveAttribute("data-example-state", "ready", { timeout: 120000 });
});

test("the automation operation returns the image, gradients and acquisition sidecar", async ({ page }) => {
  const series = dwiSeries();
  series.files.push({
    name: "sub-01_dwi.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05 })),
  });
  await page.goto("/");
  await page.locator("#neurodesk-input-transfer").setInputFiles(series.files);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch("adopt", { role: "image" });
    await globalThis.neurodeskAutomation.dispatch("start", {});
  });
  await expect
    .poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).state), { timeout: 60000 })
    .toBe("succeeded");
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
  expect(report.provenance.method).toBe("patch2self-v1-dipy-1.12.1-port");
  expect(report.provenance.groups).toEqual([[1, 2, 3, 4]]);
  expect(Object.keys(report.artifacts).sort()).toEqual(["bval", "bvec", "image", "sidecar"]);
  const event = page.waitForEvent("download");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("download", { artifactId: "sidecar" }));
  const sidecar = await event;
  expect(sidecar.suggestedFilename()).toBe("sub-01_desc-denoised_dwi.json");
  expect(JSON.parse(readFileSync(await sidecar.path(), "utf8"))).toMatchObject({
    PhaseEncodingDirection: "j-",
    TotalReadoutTime: 0.05,
  });
});

test("a DICOM series without diffusion gradients is converted and then refused", async ({ page }) => {
  await page.goto("/");
  await page.locator("#imageInput").setInputFiles(dicomSeries({ slices: 16, patient: { birthDate: "19800102" } }));
  await expect(page.locator("#statusText")).toContainText("Choose the .bval file with", { timeout: 60000 });
  await expect(page.locator("#runButton")).toBeDisabled();
});

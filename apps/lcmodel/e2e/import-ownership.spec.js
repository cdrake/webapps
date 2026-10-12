import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);
const file = (name, buffer) => ({ name, mimeType: "application/octet-stream", buffer });
const raw = file("patient-A.RAW", await readFile(new URL("data.raw", native)));
const control = file("control.file", await readFile(new URL("control.file", native)));
const basis = file("3t.basis", await readFile(new URL("3t.basis", native)));
const anatomy = file("patient-A.nii", syntheticNifti({ dims: [16, 16, 16], gzip: false }));
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

async function adopt(page, role, files) {
  await page.locator("#neurodesk-input-transfer").setInputFiles(files);
  await dispatch(page, "adopt", { role });
}

async function finish(page, parameters = {}) {
  await dispatch(page, "start", { operation: "fit", parameters });
  await expect.poll(async () => (await dispatch(page, "snapshot")).state, { timeout: 120000 }).not.toBe("running");
  return dispatch(page, "snapshot");
}

async function seed(page, parameters = {}) {
  await page.goto("/");
  await adopt(page, "spectra", [raw, control]);
  await adopt(page, "basis", [basis]);
  const result = await finish(page, { lineBroadening: "lcmodel", ...parameters });
  expect(result.state, JSON.stringify(result.error)).toBe("succeeded");
}

async function resident(page) {
  return page.evaluate(() => {
    const text = (id) => document.getElementById(id).textContent;
    const value = (id) => document.getElementById(id).value;
    return {
      file: text("fileInfo"), basis: text("basisInfo"), t1: text("t1Info"),
      results: text("concBody"), downloads: text("resultList"),
      frequency: value("hzpppmInput"), dwell: value("dwellInput"), basisChoice: value("basisSelect"),
      badSd: value("badSd"), removeBad: document.getElementById("removeBad").checked,
      drift: document.getElementById("driftCorrection").checked,
      fractions: ["fGm", "fWm", "fCsf"].map(id => document.getElementById(id)?.value),
    };
  });
}

test("automation refuses additions as spectra and preserves the resident fitted session", async ({ page }) => {
  test.setTimeout(240000);
  await seed(page, { removeBadAverages: false, badAverageSd: 5, driftCorrection: false });
  await page.locator("#t1Input").setInputFiles(anatomy);
  await expect(page.locator("#t1Info")).toContainText("patient-A.nii");
  const before = await resident(page);
  for (const files of [[file("patient-B.nii", anatomy.buffer)], [basis], [file("patient-B.H2O", raw.buffer)]]) {
    await adopt(page, "spectra", files);
    await adopt(page, "basis", [basis]);
    const result = await finish(page);
    expect(result.state, JSON.stringify(result.report)).toBe("failed");
    expect(result.error.message).toMatch(/spectroscopy|spectrum/i);
    expect(await resident(page)).toEqual(before);
  }
  await page.locator("#runButton").click();
  await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 120000 });
  expect(await page.locator("#concBody").textContent()).toBe(before.results);
});

test("automation stages optional inputs and fractions before replacing the session", async ({ page }) => {
  test.setTimeout(240000);
  await seed(page, { removeBadAverages: false, badAverageSd: 5, driftCorrection: false });
  await page.locator("#t1Input").setInputFiles(anatomy);
  await expect(page.locator("#t1Info")).toContainText("patient-A.nii");
  const before = await resident(page);
  for (const request of [
    { basis: [file("bad.basis", Buffer.from("invalid basis"))] },
    { t1: [file("bad.nii", Buffer.from("invalid image"))] },
    { parameters: { fractionGM: 0.6 } },
    { t1: [anatomy], parameters: { fractionGM: 0.6, fractionWM: 0.3, fractionCSF: 0.1 } },
  ]) {
    await adopt(page, "spectra", [file("patient-B.RAW", raw.buffer), control]);
    await adopt(page, "basis", request.basis ?? [basis]);
    await adopt(page, "t1", request.t1 ?? []);
    const result = await finish(page, request.parameters);
    expect(result.state).toBe("failed");
    expect(await resident(page)).toEqual(before);
  }
  await adopt(page, "spectra", [file("patient-B.RAW", raw.buffer), control]);
  await adopt(page, "basis", [basis]);
  await adopt(page, "t1", []);
  const result = await finish(page, { lineBroadening: "lcmodel" });
  expect(result.state, JSON.stringify(result.error)).toBe("succeeded");
  await expect(page.locator("#fileInfo")).toHaveText("patient-B.RAW");
  await expect(page.locator("#t1Info")).toBeHidden();
});

for (const edited of [true, false]) {
  test(`RAW water attachment preserves explicit edited ${edited}`, async ({ page }) => {
    test.setTimeout(240000);
    await page.goto("/");
    const name = edited ? "ordinary.RAW" : "MEGA-PRESS.RAW";
    const spectrum = edited ? raw.buffer : Buffer.concat([Buffer.from(" $SEQPAR\n seq='MEGA-PRESS'\n $END\n"), raw.buffer]);
    await adopt(page, "spectra", [file(name, spectrum), control]);
    await adopt(page, "basis", [basis]);
    await finish(page, { edited, lineBroadening: "lcmodel", macromoleculeModel: "none" });
    if (edited) await expect(page.locator("#lineBroadening")).toBeDisabled();
    else await expect(page.locator("#lineBroadening")).toBeEnabled();
    const frequency = await page.locator("#hzpppmInput").inputValue();
    const dwell = await page.locator("#dwellInput").inputValue();
    await page.locator("#waterInput").setInputFiles(file("reference.H2O", raw.buffer));
    await expect(page.locator("#statusText")).toHaveText("Water reference attached to the selected dataset.");
    if (edited) await expect(page.locator("#lineBroadening")).toBeDisabled();
    else await expect(page.locator("#lineBroadening")).toBeEnabled();
    await expect(page.locator("#hzpppmInput")).toHaveValue(frequency);
    await expect(page.locator("#dwellInput")).toHaveValue(dwell);
    await expect(page.locator("#waterScaling")).toBeEnabled();
    await page.locator("#runButton").click();
    await expect(page.locator("#statusText")).toContainText("Fit done", { timeout: 120000 });
    await expect(page.locator("#concTable")).toBeVisible();
  });
}

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { loadHmcNode, nodeRuntime } from "@neurodesk/hmc/node";
import { correctNiFreeze } from "@neurodesk/hmc/nifreeze";
import { fixture } from "./fixtures.mjs";

test("workspace boots with shared information and GP as default", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#viewer")).toBeVisible();
  await expect(page.locator("#method")).toHaveValue("gp");
  await expect(page.locator("#workers")).toHaveValue("1");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  await page.locator(".nd-app-bar").getByRole("button", { name: "About", exact: true }).click();
  await expect(page.locator("#infoDialog")).toContainText("NiFreeze");
});

for (const model of ["trivial", "gp"]) {
  test(`${model} production browser outputs equal independent Node pipeline`, async ({ page }) => {
    test.setTimeout(180000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const data = await fixture();
    const name = "sub-01_ses-01_dwi.nii.gz";
    const inputs = {
      image: { name, bytes: data.nifti },
      bval: { name: "input.bval", bytes: Buffer.from(data.bvals.join(" ")) },
      bvec: { name: "input.bvec", bytes: Buffer.from(data.bvecs.map(row => row.join(" ")).join("\n")) },
      mask: { name: "mask.nii", bytes: data.maskNifti },
    };
    await page.goto("./");
    for (const [role, input] of Object.entries(inputs)) {
      await page.locator("#neurodesk-input-transfer").setInputFiles({ name: input.name, mimeType: "application/octet-stream", buffer: Buffer.from(input.bytes) });
      await page.evaluate(role => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
    }
    await page.evaluate(method => globalThis.neurodeskAutomation.dispatch("start", { parameters: { method, workers: 1, seed: 1234 } }), model);
    await expect.poll(() => page.evaluate(async () => {
      const state = await globalThis.neurodeskAutomation.dispatch("snapshot");
      return state.state === "failed" ? JSON.stringify(state) : state.state;
    }), { timeout: 150000 }).toBe("succeeded");
    const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch("snapshot")).report);
    const expected = await correctNiFreeze({ series: data.series, bvals: data.bvals, bvecs: data.bvecs, mask: data.mask,
      model, seed: 1234, maskProvenance: { Source: "supplied" }, fileName: name, hmc: await loadHmcNode(), runtime: nodeRuntime({ workers: 1 }),
    });
    for (const role of ["image", "bval", "bvec", "motion", "sidecar", "transforms"]) {
      const event = page.waitForEvent("download");
      await page.evaluate(artifactId => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), role);
      const bytes = new Uint8Array(await readFile(await (await event).path()));
      if (role === "transforms") {
        const files = unzipSync(bytes);
        expect(Object.keys(files).sort()).toEqual(Object.keys(expected.files).filter(name => name.endsWith(".mat")).sort());
        for (const [name, bytes] of Object.entries(files)) expect(bytes, name).toEqual(expected.files[name]);
      } else {
        const wanted = expected.files[expected.names[role]];
        expect(role === "image" ? gunzipSync(bytes) : bytes, role).toEqual(role === "image" ? gunzipSync(wanted) : wanted);
      }
      expect(report.artifacts[role]).toBeTruthy();
    }
    expect(errors).toEqual([]);
  });
}

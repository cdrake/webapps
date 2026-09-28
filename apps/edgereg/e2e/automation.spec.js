import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const fixture = await readFile(new URL("../../../exes/synthseg/test/fixtures/small.nii.gz", import.meta.url));
const digest = createHash("sha256").update(fixture).digest("hex");

async function adopt(page, role, name, buffer = fixture) {
  await page.locator("#neurodesk-input-transfer").setInputFiles({ name, mimeType: "application/gzip", buffer });
  await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch("adopt", { role }), role);
}

test("automation runs affine registration on explicit input roles and exports the verified output", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  await adopt(page, "moving", "subject.nii.gz");
  await adopt(page, "fixed", "reference.nii.gz");
  const run = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", {
    operation: "register", parameters: { robustFov: false },
  }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state, { timeout: 60_000 }).toBe("succeeded");
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.runId).toBe(run.runId);
  expect(snapshot.report.inputs.moving[0]).toMatchObject({ filename: "subject.nii.gz", sha256: digest });
  expect(snapshot.report.inputs.fixed[0]).toMatchObject({ filename: "reference.nii.gz", sha256: digest });
  expect(snapshot.report.provenance.algorithm).toBe("niimath allineate");
  const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, value]) => value.role === "registered");
  const downloaded = page.waitForEvent("download");
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch("download", { artifactId }), id);
  const download = await downloaded;
  const image = await readFile(await download.path());
  expect(download.suggestedFilename()).toBe("subject_registered.nii");
  expect(image.readInt32LE(0)).toBe(348);
  expect(artifact).toMatchObject({ space: "fixed", bytes: image.length, sha256: createHash("sha256").update(image).digest("hex") });
  await expect(page.locator("#movingInfo")).toHaveText("subject.nii.gz");
  await expect(page.locator("#stationaryInfo")).toHaveText("reference.nii.gz");
});

test("an invalid input fails before registration without publishing artifacts", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#movingInput")).toBeEnabled();
  await adopt(page, "moving", "broken.nii", Buffer.from("not a NIfTI"));
  await adopt(page, "fixed", "reference.nii.gz");
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("start", { operation: "register" }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"))).state).toBe("failed");
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch("snapshot"));
  expect(snapshot.error.message).toBeTruthy();
  expect(snapshot.report).toBeUndefined();
  await expect(page.locator("#resultList").getByRole("button", { name: "Download" })).toHaveCount(0);
});

import { test, expect } from "@playwright/test";
import { dicomSeries } from "../../../test-utils/dicom-fixture.mjs";

test("imports extensionless DICOM and switches between converted series", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(page.locator("#statusText")).toHaveText("Drag and drop files", { timeout: 60000 });
  await page.locator("#movingInput").setInputFiles(dicomSeries({ extension: "" }));
  await expect(page.locator("#movingInfo")).toContainText("test_scan_1", { timeout: 60000 });
  await expect(page.locator("#movingInfo")).toContainText(".nii");
  await expect(page.locator("#movingInput")).toBeEnabled({ timeout: 60000 });
  await page.locator("#fixedInput").setInputFiles([
    ...dicomSeries({ extension: ".IMA" }),
    ...dicomSeries({ series: 2, extension: ".IMA" }),
  ]);
  const series = page.locator("#fixedSeries");
  await expect(series.locator("option")).toHaveCount(2, { timeout: 60000 });
  await expect(page.locator("#fixedInput")).toBeEnabled({ timeout: 60000 });
  const next = await series.locator("option").nth(1).textContent();
  await series.selectOption("1");
  await expect(page.locator("#fixedInfo")).toContainText(next, { timeout: 60000 });
});

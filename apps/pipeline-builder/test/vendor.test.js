import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadCatalogContracts, neuroflowBundleFiles } from "../../../scripts/lib/neuroflow-bundle.mjs";
import { createValidator } from "../src/validator.js";

const vendor = new URL("../vendor/neuroflow/", import.meta.url);
const provenance = JSON.parse(readFileSync(new URL("provenance.json", vendor), "utf8"));

test("vendored NeuroFlow files match their recorded hashes", () => {
  for (const [name, sha256] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(name, vendor))).digest("hex"), sha256, name);
  }
  assert.match(provenance.commit, /^[0-9a-f]{40}$/);
});

test("the template validates against the generated catalog", async () => {
  const { tools } = await neuroflowBundleFiles(await loadCatalogContracts({ exclude: ["pipeline-builder"] }));
  const validate = await createValidator(tools, readFileSync(new URL("neuroflow_wasm_bg.wasm", vendor)));
  const template = JSON.parse(readFileSync(new URL("../src/workflows/t1-segmentation.workflow.json", import.meta.url), "utf8"));
  const result = validate(template);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  // A single volume fills N4's array input (NeuroFlow single-to-array rule).
  assert.ok(!result.issues.some(issue => issue.path === "steps.n4.inputs.input_image"));
  const broken = structuredClone(template);
  broken.steps.segment.inputs.input_image = { ref: "steps.n4.outputs.report" };
  assert.ok(validate(broken).issues.some(issue => issue.severity === "error" && issue.path === "steps.segment.inputs.input_image"));
});

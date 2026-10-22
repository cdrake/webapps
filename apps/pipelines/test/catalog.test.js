// The bundle the page and NeuroFlow clients load, checked with the vendored validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateTool } from "../../../packages/desktop/neuroflow/generator.mjs";
import { bundleFiles } from "../scripts/catalog.mjs";
import { APP } from "../src/config.js";
import { validateWorkflow } from "../src/validator.js";
import { usedTools } from "../src/workflow.js";

const files = await bundleFiles();
const index = JSON.parse(files.get("neuroflow-registry.json"));
const tools = new Map(index.tools.map((path) => JSON.parse(files.get(path))).map((tool) => [tool.id, tool]));
const wasm = await readFile(new URL("../vendor/neuroflow/neuroflow_bg.wasm", import.meta.url));

test("the index lists every tool and workflow, sorted, and nothing else", () => {
  assert.equal(index.kind, "neuroflow/registry-index");
  assert.deepEqual(index.tools, [...index.tools].sort());
  assert.deepEqual([...index.tools, ...index.workflows].sort(), [...files.keys()].filter((path) => /\.(tool|workflow)\.json$/.test(path)).sort());
  assert.ok(tools.size > 40);
});

test("every tool is a valid NeuroFlow tool and the builder does not list itself", () => {
  for (const tool of tools.values()) validateTool(tool);
  assert.ok(![...tools.keys()].some((id) => id.startsWith(`neurodesk.webapps/${APP.id}/`)));
});

test("every shipped workflow validates against the catalog", async () => {
  assert.ok(index.workflows.length > 0);
  for (const path of index.workflows) {
    const workflow = JSON.parse(files.get(path));
    const report = await validateWorkflow(workflow, usedTools(workflow, tools), wasm);
    assert.equal(report.ok, true, `${path}: ${JSON.stringify(report.issues)}`);
  }
});

test("the validator rejects a step bound to an output of the wrong type", async () => {
  const workflow = JSON.parse(files.get("workflows/n4-extract-synthseg.workflow.json"));
  workflow.steps.extract.inputs.input_image = { ref: "steps.correct.outputs.report" };
  const report = await validateWorkflow(workflow, usedTools(workflow, tools), wasm);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.path === "steps.extract.inputs.input_image" && issue.severity === "error"));
});

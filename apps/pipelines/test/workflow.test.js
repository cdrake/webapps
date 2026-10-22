// DOM-free tests of the workflow model (src/workflow.js) on the real generated tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleFiles } from "../scripts/catalog.mjs";
import {
  addStep, addWorkflowInput, bindingSources, emptyWorkflow, exposedAs, isTypeCompatible,
  moveStep, parseWorkflow, pickSource, removeStep, setBinding, setExposed,
} from "../src/workflow.js";

const files = await bundleFiles();
const tools = new Map([...files].filter(([path]) => path.startsWith("tools/")).map(([, text]) => JSON.parse(text)).map((tool) => [tool.id, tool]));
const N4 = tools.get("neurodesk.webapps/n4/correct");
const EXTRACT = tools.get("neurodesk.webapps/brain-extraction/extract");
const SYNTHSEG = tools.get("neurodesk.webapps/synthseg/segment");

test("type compatibility follows neuroflow-core", () => {
  assert.ok(isTypeCompatible("neuro:mask", "neuro:volume"));
  assert.ok(isTypeCompatible("core:array<neuro:mask>", "core:array<neuro:volume>"));
  assert.ok(!isTypeCompatible("neuro:volume", "neuro:mask"));
  assert.ok(!isTypeCompatible("neuro:report", "neuro:volume"));
  // A single volume does not fill an array input under neuroflow-spec 0.1.
  assert.ok(!isTypeCompatible("neuro:volume", "core:array<neuro:volume>"));
});

test("a first step binds its required inputs to new workflow inputs", () => {
  const workflow = emptyWorkflow();
  const id = addStep(workflow, tools, N4);
  assert.equal(id, "correct");
  assert.deepEqual(workflow.steps.correct.inputs, { input_image: { ref: "inputs.image" } });
  assert.equal(workflow.inputs.image.type, "core:array<neuro:volume>");
});

test("a later step binds to the earlier output whose name matches, not the first of its type", () => {
  const workflow = emptyWorkflow();
  addStep(workflow, tools, N4);
  addStep(workflow, tools, EXTRACT);
  assert.deepEqual(workflow.steps.extract.inputs.input_image, { ref: "steps.correct.outputs.output_image" });
});

test("without a name match the latest compatible output wins", () => {
  const sources = [
    { ref: "steps.a.outputs.output_labels", compatible: true },
    { ref: "steps.b.outputs.output_brain", compatible: true },
    { ref: "steps.b.outputs.report", compatible: false },
  ];
  assert.equal(pickSource(sources, "input_t1")?.ref, "steps.b.outputs.output_brain");
  assert.equal(pickSource([{ ref: "inputs.t1", compatible: true }], "input_t1"), undefined);
});

test("sources come only from earlier steps", () => {
  const workflow = emptyWorkflow();
  addStep(workflow, tools, N4);
  addStep(workflow, tools, EXTRACT);
  const refs = bindingSources(workflow, tools, "correct", "neuro:volume").map((source) => source.ref);
  assert.deepEqual(refs, ["inputs.image"]);
});

test("repeated tools get distinct step ids", () => {
  const workflow = emptyWorkflow();
  addStep(workflow, tools, EXTRACT);
  assert.equal(addStep(workflow, tools, EXTRACT), "extract-2");
});

test("moving and removing steps keeps the document consistent", () => {
  const workflow = emptyWorkflow();
  addStep(workflow, tools, N4);
  addStep(workflow, tools, EXTRACT);
  addStep(workflow, tools, SYNTHSEG);
  moveStep(workflow, "segment", -1);
  assert.deepEqual(Object.keys(workflow.steps), ["correct", "segment", "extract"]);
  moveStep(workflow, "correct", -1);
  assert.deepEqual(Object.keys(workflow.steps), ["correct", "segment", "extract"]);
  setExposed(workflow, tools, "extract", "output_mask", true);
  assert.equal(exposedAs(workflow, "extract", "output_mask"), "extract_mask");
  assert.equal(workflow.outputs.extract_mask.type, "neuro:mask");
  removeStep(workflow, "correct");
  assert.deepEqual(workflow.steps.extract.inputs, {});
  assert.deepEqual(workflow.inputs, {}, "a workflow input no step reads is dropped");
  removeStep(workflow, "extract");
  assert.deepEqual(workflow.outputs, {});
});

test("clearing a binding drops the workflow input it used", () => {
  const workflow = emptyWorkflow();
  addStep(workflow, tools, EXTRACT);
  const ref = addWorkflowInput(workflow, "input_image", EXTRACT.inputs.input_image);
  setBinding(workflow, "extract", "input_image", { ref });
  assert.deepEqual(Object.keys(workflow.inputs), ["image-2"]);
  setBinding(workflow, "extract", "input_image", null);
  assert.deepEqual(workflow.inputs, {});
});

test("only workflow documents open", () => {
  assert.throws(() => parseWorkflow(JSON.stringify({ kind: "tool" })), /Not a NeuroFlow workflow/);
  assert.deepEqual(parseWorkflow(JSON.stringify({ kind: "workflow", steps: {} })).outputs, {});
});

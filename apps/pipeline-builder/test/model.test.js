import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  addStep, bindInput, bindNewWorkflowInput, candidateSources, compatibleSources, elementType, emptyWorkflow,
  issuesByStep, parseWorkflow, preferredSource, removeStep, serializeWorkflow, setParameter, setWorkflowOutput, toolCatalog, toolLabel,
} from "../src/model.js";

const tool = (app, operation, inputs, outputs) => ({
  id: `neurodesk.webapps/${app}/${operation}`,
  inputs,
  outputs,
  extensions: { "neurodesk/automation": { operation, contract: { app, title: app.toUpperCase(), operations: { [operation]: { title: operation } } } } },
});
const n4 = tool("n4", "correct",
  { input_image: { type: "core:array<neuro:volume>", formats: ["nifti"], description: "Image" }, param_iterations: { type: "core:number", default: 50, optional: true } },
  { output_image: { type: "neuro:volume" }, report: { type: "neuro:report" } });
const bet = tool("bet", "extract", { input_image: { type: "neuro:volume" } }, { output_brain: { type: "neuro:volume" } });
const tools = [n4, bet];

test("a new step gets a unique local id from its app", () => {
  let doc = emptyWorkflow();
  ({ doc } = addStep(doc, n4));
  const second = addStep(doc, n4);
  assert.deepEqual(Object.keys(second.doc.steps), ["n4", "n4-2"]);
  assert.deepEqual(second.doc.steps["n4-2"], { tool: n4.id, inputs: {} });
});

test("a new workflow input takes the element type and formats of an array input", () => {
  const { doc } = addStep(emptyWorkflow(), n4);
  const bound = bindNewWorkflowInput(doc, "n4", "input_image", n4);
  assert.equal(elementType("core:array<neuro:volume>"), "neuro:volume");
  assert.deepEqual(bound.inputs.image, { type: "neuro:volume", formats: ["nifti"], description: "Image" });
  assert.deepEqual(bound.steps.n4.inputs.input_image, { ref: "inputs.image" });
});

test("candidates are workflow inputs and earlier step outputs, filtered by the validator", () => {
  let doc = bindNewWorkflowInput(addStep(emptyWorkflow(), n4).doc, "n4", "input_image", n4);
  doc = addStep(doc, bet).doc;
  assert.deepEqual(candidateSources(doc, "bet", tools).map(source => source.ref),
    ["inputs.image", "steps.n4.outputs.output_image", "steps.n4.outputs.report"]);
  assert.deepEqual(candidateSources(doc, "n4", tools).map(source => source.ref), ["inputs.image"]);
  const validate = trial => ({
    issues: trial.steps.bet.inputs.input_image?.ref.endsWith("report")
      ? [{ severity: "error", path: "steps.bet.inputs.input_image", message: "incompatible" }]
      : [{ severity: "error", path: "steps.other.inputs.x", message: "unrelated" }],
  });
  assert.deepEqual(compatibleSources(doc, "bet", "input_image", tools, validate).map(source => source.ref),
    ["inputs.image", "steps.n4.outputs.output_image"]);
});

test("a parameter equal to its default is not written", () => {
  const { doc } = addStep(emptyWorkflow(), n4);
  const set = setParameter(doc, "n4", "param_iterations", 20, n4);
  assert.deepEqual(set.steps.n4.inputs.param_iterations, { constant: 20 });
  assert.equal(setParameter(set, "n4", "param_iterations", 50, n4).steps.n4.inputs.param_iterations, undefined);
  assert.equal(setParameter(set, "n4", "param_iterations", Number.NaN, n4).steps.n4.inputs.param_iterations, undefined);
});

test("workflow outputs toggle and removing a step drops what read it", () => {
  let doc = bindNewWorkflowInput(addStep(emptyWorkflow(), n4).doc, "n4", "input_image", n4);
  doc = bindInput(addStep(doc, bet).doc, "bet", "input_image", "steps.n4.outputs.output_image");
  doc = setWorkflowOutput(doc, "n4", "output_image", true, n4);
  doc = setWorkflowOutput(doc, "bet", "output_brain", true, bet);
  assert.deepEqual(doc.outputs.image, { type: "neuro:volume", ref: "steps.n4.outputs.output_image" });
  assert.deepEqual(setWorkflowOutput(doc, "bet", "output_brain", false, bet).outputs, { image: doc.outputs.image });
  const removed = removeStep(doc, "n4");
  assert.deepEqual(Object.keys(removed.steps), ["bet"]);
  assert.deepEqual(removed.steps.bet.inputs, {});
  assert.deepEqual(removed.outputs, { brain: doc.outputs.brain });
  assert.deepEqual(removed.inputs, {});
});

test("a binding change drops the workflow input only the replaced binding read", () => {
  const doc = {
    ...emptyWorkflow(),
    inputs: { t1: { type: "neuro:volume" }, iterations: { type: "core:number" }, spare: { type: "core:string" } },
    steps: {
      n4: { tool: n4.id, inputs: { input_image: { ref: "inputs.t1" }, param_iterations: { ref: "inputs.iterations" } } },
      bet: { tool: bet.id, inputs: { input_image: { ref: "inputs.t1" } } },
    },
  };
  const names = next => Object.keys(next.inputs);
  assert.deepEqual(names(bindNewWorkflowInput(doc, "n4", "input_image", n4)), ["t1", "iterations", "spare", "image"]);
  const alone = bindInput(doc, "bet", "input_image", "steps.n4.outputs.output_image");
  assert.deepEqual(names(alone), ["t1", "iterations", "spare"]);
  assert.deepEqual(names(bindNewWorkflowInput(alone, "n4", "input_image", n4)), ["iterations", "spare", "image"]);
  assert.deepEqual(names(bindInput(alone, "n4", "input_image", null)), ["iterations", "spare"]);
  assert.deepEqual(names(bindInput(alone, "n4", "input_image", "inputs.t1")), ["t1", "iterations", "spare"]);
  assert.deepEqual(names(setParameter(alone, "n4", "param_iterations", 20, n4)), ["t1", "spare"]);
});

test("documents round-trip at NeuroFlow 0.1.1 and non-workflows are refused", () => {
  const doc = parseWorkflow(JSON.stringify({ neuroflow: "0.1.0", kind: "workflow", id: "a.b/c", steps: {} }));
  assert.equal(JSON.parse(serializeWorkflow(doc)).neuroflow, "0.1.1");
  assert.throws(() => parseWorkflow("{}"), /not a NeuroFlow workflow/);
  assert.throws(() => parseWorkflow("nope"), /not JSON/);
});

test("issues group by step and tools group by app", () => {
  const grouped = issuesByStep([{ path: "steps.n4.inputs.x" }, { path: "outputs.y" }]);
  assert.deepEqual([...grouped.keys()], ["n4", ""]);
  assert.deepEqual(toolCatalog(tools).map(group => group.title), ["BET", "N4"]);
  assert.equal(toolLabel(n4), "N4 · correct");
});

test("the shipped template is a 0.1.1 workflow over catalog operations", () => {
  const dir = new URL("../src/workflows/", import.meta.url);
  for (const name of readdirSync(dir)) {
    const doc = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    assert.equal(doc.neuroflow, "0.1.1");
    assert.equal(doc.kind, "workflow");
    for (const step of Object.values(doc.steps)) assert.match(step.tool, /^neurodesk\.webapps\/[a-z0-9-]+\/[a-z0-9-]+$/);
  }
});

test("a new input prefers the latest step, then a matching name, then an exact type", () => {
  const decl = { type: "neuro:volume" };
  const sources = [
    { ref: "inputs.t1", type: "neuro:volume" },
    { ref: "steps.n4.outputs.output_bias", type: "neuro:volume" },
    { ref: "steps.n4.outputs.output_image", type: "neuro:volume" },
    { ref: "steps.n4.outputs.output_mask", type: "neuro:mask" },
  ];
  assert.equal(preferredSource(sources, "input_image", decl).ref, "steps.n4.outputs.output_image");
  assert.equal(preferredSource(sources.slice(1), "input_brain", decl).ref, "steps.n4.outputs.output_bias");
  assert.equal(preferredSource([sources[3]], "input_brain", decl).ref, "steps.n4.outputs.output_mask");
  assert.equal(preferredSource([], "input_image", decl), undefined);
});

// The pipeline being edited is a NeuroFlow workflow document, kept as plain
// JSON. These functions edit it; steps run in the order of `workflow.steps`.
// DOM-free, so test/workflow.test.js runs them under Node.

/**
 * Whether a `source` value may be bound to an input of type `target`.
 * Mirrors neuroflow-core `is_type_compatible` at the vendored commit; the WASM
 * validator stays the authority, this only filters what the pickers offer.
 */
export function isTypeCompatible(source, target) {
  if (source === target || COERCIONS[source]?.includes(target)) return true;
  const [from, to] = [arrayElement(source), arrayElement(target)];
  return Boolean(from && to && isTypeCompatible(from, to));
}

const COERCIONS = {
  "core:string": ["core:directory", "core:file"],
  "core:directory": ["core:string"],
  "core:file": ["core:string"],
  "neuro:volume": ["core:file", "core:string"],
  "neuro:ome-zarr": ["neuro:ngff-zarr", "core:directory", "core:string"],
  "neuro:ngff-zarr": ["neuro:ome-zarr", "core:directory", "core:file", "core:json", "core:string"],
  "neuro:tract": ["core:file", "core:string"],
  "neuro:surface": ["core:file", "core:string"],
  "neuro:mask": ["neuro:volume", "core:file", "core:string"],
  "neuro:statmap": ["neuro:volume", "core:file", "core:string"],
  "neuro:probseg": ["neuro:volume", "core:file", "core:string"],
  "neuro:cifti": ["core:file", "core:string"],
  "neuro:gradient-table": ["core:file", "core:string"],
  "neuro:connectivity-matrix": ["core:tabular", "core:file", "core:string"],
  "neuro:qc-metrics": ["core:json", "core:file", "core:string"],
  "neuro:report": ["core:file", "core:string"],
  "core:tabular": ["core:file", "core:string"],
  "neuro:bids-dataset": ["core:directory", "core:string"],
  "neurovue:correction-patch": ["core:json", "core:file", "core:string"],
};

const arrayElement = (type) => /^core:array<(.+)>$/.exec(type)?.[1];

export function emptyWorkflow() {
  return {
    neuroflow: "0.1.1",
    kind: "workflow",
    id: "neurodesk.webapps/pipelines/untitled",
    version: "0.1.0",
    description: "A pipeline of Neurodesk web apps.",
    inputs: {},
    steps: {},
    outputs: {},
  };
}

/** Data ports carry files between steps; every other input is a setting. */
export const isDataInput = (declaration) => Boolean(declaration.extensions?.["neurodesk/data"]);

/** "N4 · Correct bias field" for a generated tool. */
export function toolLabel(tool) {
  const { contract, operation } = tool.extensions["neurodesk/automation"];
  return `${contract.title} · ${contract.operations[operation].title}`;
}

/**
 * Everything an input of `stepId` may be bound to: the workflow inputs and the
 * outputs of earlier steps, each with whether its type fits `type`.
 */
export function bindingSources(workflow, tools, stepId, type) {
  const sources = Object.entries(workflow.inputs).map(([name, input]) => ({ ref: `inputs.${name}`, type: input.type }));
  for (const [id, step] of Object.entries(workflow.steps)) {
    if (id === stepId) break;
    for (const [name, output] of Object.entries(tools.get(step.tool)?.outputs ?? {})) {
      sources.push({ ref: `steps.${id}.outputs.${name}`, type: output.type });
    }
  }
  return sources.map((source) => ({ ...source, compatible: isTypeCompatible(source.type, type) }));
}

/**
 * The source a new step's input is bound to: the compatible one whose name
 * matches the input's, else the latest compatible output. Several outputs of a
 * tool can share a type (N4 writes `output_image` and `output_bias`), so type
 * alone picks the wrong one. Same rule as NeuroFlow's `pickAutoBinding`.
 */
export function pickSource(sources, inputName) {
  const target = portStem(inputName);
  const score = ({ ref }) => {
    const source = portStem(ref.slice(ref.lastIndexOf(".") + 1));
    if (source === target) return 2;
    return source.includes(target) || target.includes(source) ? 1 : 0;
  };
  return sources
    .map((source, order) => ({ source, order, score: score(source) }))
    .filter(({ source }) => source.compatible && source.ref.startsWith("steps."))
    .sort((a, b) => b.score - a.score || b.order - a.order)[0]?.source;
}

const portStem = (name) => name.toLowerCase().replace(/^(input|output|in|out|param)_/, "");

const unique = (taken, base) => {
  let name = base;
  for (let n = 2; name in taken; n += 1) name = `${base}-${n}`;
  return name;
};

/**
 * Appends a step for `tool` and binds each required data input: to a matching
 * earlier output, or to a new workflow input of the same type. Settings keep
 * the tool's defaults until changed. Returns the new step id.
 */
export function addStep(workflow, tools, tool) {
  const { operation } = tool.extensions["neurodesk/automation"];
  const id = unique(workflow.steps, operation);
  const step = { tool: tool.id, inputs: {} };
  workflow.steps[id] = step;
  for (const [name, input] of Object.entries(tool.inputs)) {
    if (input.optional || !isDataInput(input)) continue;
    const source = pickSource(bindingSources(workflow, tools, id, input.type), name);
    step.inputs[name] = { ref: source?.ref ?? addWorkflowInput(workflow, name, input) };
  }
  return id;
}

/** Declares a workflow input for `declaration` and returns its ref. */
export function addWorkflowInput(workflow, portName, declaration) {
  const name = unique(workflow.inputs, portStem(portName));
  workflow.inputs[name] = { type: declaration.type, description: declaration.description };
  return `inputs.${name}`;
}

/** Sets or clears (`binding` null) one input of a step, then drops unused workflow inputs. */
export function setBinding(workflow, stepId, input, binding) {
  const inputs = workflow.steps[stepId].inputs;
  if (binding) inputs[input] = binding;
  else delete inputs[input];
  pruneInputs(workflow);
}

export function moveStep(workflow, stepId, offset) {
  const ids = Object.keys(workflow.steps);
  const from = ids.indexOf(stepId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  workflow.steps = Object.fromEntries(ids.map((id) => [id, workflow.steps[id]]));
}

/** Removes a step, unbinding every input and workflow output that read from it. */
export function removeStep(workflow, stepId) {
  delete workflow.steps[stepId];
  const prefix = `steps.${stepId}.`;
  for (const step of Object.values(workflow.steps)) {
    for (const [name, binding] of Object.entries(step.inputs)) {
      if (binding.ref?.startsWith(prefix)) delete step.inputs[name];
    }
  }
  for (const [name, output] of Object.entries(workflow.outputs)) {
    if (output.ref.startsWith(prefix)) delete workflow.outputs[name];
  }
  pruneInputs(workflow);
}

/** The workflow output name that exposes `steps.<stepId>.outputs.<output>`, if any. */
export function exposedAs(workflow, stepId, output) {
  const ref = `steps.${stepId}.outputs.${output}`;
  return Object.entries(workflow.outputs).find(([, declaration]) => declaration.ref === ref)?.[0];
}

export function setExposed(workflow, tools, stepId, output, exposed) {
  const current = exposedAs(workflow, stepId, output);
  if (!exposed) {
    if (current) delete workflow.outputs[current];
    return;
  }
  if (current) return;
  const { type } = tools.get(workflow.steps[stepId].tool).outputs[output];
  workflow.outputs[unique(workflow.outputs, `${stepId}_${portStem(output)}`)] = { type, ref: `steps.${stepId}.outputs.${output}` };
}

function pruneInputs(workflow) {
  const used = new Set(Object.values(workflow.steps).flatMap((step) => Object.values(step.inputs).map((binding) => binding.ref)));
  for (const name of Object.keys(workflow.inputs)) {
    if (!used.has(`inputs.${name}`)) delete workflow.inputs[name];
  }
}

/** Reads a dropped or opened document; throws when it is not a NeuroFlow workflow. */
export function parseWorkflow(text) {
  const workflow = JSON.parse(text);
  if (workflow?.kind !== "workflow" || typeof workflow.steps !== "object" || workflow.steps === null) {
    throw new Error("Not a NeuroFlow workflow document");
  }
  return { inputs: {}, outputs: {}, ...workflow };
}

/** The tools a workflow uses, as the validator expects them. */
export const usedTools = (workflow, tools) =>
  [...new Set(Object.values(workflow.steps).map((step) => step.tool))].map((id) => tools.get(id)).filter(Boolean);

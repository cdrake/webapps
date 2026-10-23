// DOM-independent workflow editing. The state is the NeuroFlow workflow document
// itself; every edit returns a new document. Type checking is not repeated here:
// callers pass `validate(doc)` (the NeuroFlow core) wherever compatibility matters.
export const NEUROFLOW_VERSION = "0.1.1";
const LOCAL_ID = /^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;

export function emptyWorkflow() {
  return {
    neuroflow: NEUROFLOW_VERSION,
    kind: "workflow",
    id: "neurodesk.pipelines/untitled",
    version: "0.1.0",
    description: "",
    inputs: {},
    steps: {},
    outputs: {},
  };
}

export function parseWorkflow(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error("The file is not JSON."); }
  if (doc?.kind !== "workflow" || typeof doc.steps !== "object" || !doc.steps) {
    throw new Error("The file is not a NeuroFlow workflow.");
  }
  return { ...emptyWorkflow(), ...doc, neuroflow: NEUROFLOW_VERSION };
}

export function serializeWorkflow(doc) {
  return `${JSON.stringify({ ...doc, neuroflow: NEUROFLOW_VERSION }, null, 2)}\n`;
}

export function elementType(type) {
  return /^core:array<(.+)>$/.exec(type)?.[1] ?? type;
}

const automation = tool => tool.extensions?.["neurodesk/automation"];

/** "Brain extraction · Extract brain" for a generated Neurodesk tool, else its id. */
export function toolLabel(tool) {
  const binding = automation(tool);
  const operation = binding?.contract.operations[binding.operation];
  return binding ? `${binding.contract.title} · ${operation?.title ?? binding.operation}` : tool.id;
}

/** Tools grouped by app title, for an operation picker. */
export function toolCatalog(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const title = automation(tool)?.contract.title ?? "Other";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(tool);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([title, list]) => ({ title, tools: list.sort((a, b) => a.id.localeCompare(b.id)) }));
}

/** A tool's inputs split into data inputs, parameters and the engine choice. */
export function toolFields(tool) {
  const entries = Object.entries(tool.inputs ?? {});
  return {
    data: entries.filter(([name]) => name.startsWith("input_")),
    parameters: entries.filter(([name]) => name.startsWith("param_")),
    engine: tool.inputs?.engine,
  };
}

function uniqueId(base, taken) {
  let id = base.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "") || "step";
  if (!LOCAL_ID.test(id)) id = "step";
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

export function addStep(doc, tool) {
  const stepId = uniqueId(automation(tool)?.contract.app ?? tool.id.split("/").pop(), new Set(Object.keys(doc.steps)));
  return { doc: { ...doc, steps: { ...doc.steps, [stepId]: { tool: tool.id, inputs: {} } } }, stepId };
}

function withStep(doc, stepId, change) {
  const step = doc.steps[stepId];
  if (!step) throw new Error(`No step ${stepId}.`);
  return { ...doc, steps: { ...doc.steps, [stepId]: change(step) } };
}

/**
 * Drop the workflow inputs among `refs` that no step reads any more; an input nobody
 * read before the edit stays. NeuroFlow outputs reference step outputs only, so step
 * bindings are the only readers.
 */
function dropUnread(doc, refs) {
  const read = new Set(Object.values(doc.steps).flatMap(step => Object.values(step.inputs ?? {}).map(binding => binding.ref)));
  const inputs = Object.fromEntries(Object.entries(doc.inputs ?? {})
    .filter(([name]) => !refs.has(`inputs.${name}`) || read.has(`inputs.${name}`)));
  return { ...doc, inputs };
}

function withBinding(doc, stepId, name, binding) {
  const replaced = doc.steps[stepId]?.inputs?.[name]?.ref;
  return dropUnread(withStep(doc, stepId, step => {
    const inputs = { ...step.inputs };
    if (binding) inputs[name] = binding; else delete inputs[name];
    return { ...step, inputs };
  }), new Set([replaced]));
}

/** Workflow inputs, then outputs of the steps before `stepId`, as candidate refs. */
export function candidateSources(doc, stepId, tools) {
  const byId = new Map(tools.map(tool => [tool.id, tool]));
  const sources = Object.entries(doc.inputs ?? {}).map(([name, decl]) => ({ ref: `inputs.${name}`, label: `Workflow input ${name}`, type: decl.type }));
  for (const [id, step] of Object.entries(doc.steps)) {
    if (id === stepId) break;
    for (const [name, decl] of Object.entries(byId.get(step.tool)?.outputs ?? {})) {
      sources.push({ ref: `steps.${id}.outputs.${name}`, label: `${id} → ${name}`, type: decl.type });
    }
  }
  return sources;
}

/**
 * The candidates the validator accepts for one input: a trial binding counts when it
 * leaves no error on that input's path.
 */
export function compatibleSources(doc, stepId, name, tools, validate) {
  const path = `steps.${stepId}.inputs.${name}`;
  return candidateSources(doc, stepId, tools).filter(source => {
    const { issues = [] } = validate(withBinding(doc, stepId, name, { ref: source.ref }));
    return !issues.some(issue => issue.severity === "error" && issue.path === path);
  });
}

/**
 * The source a new step's input starts from: the latest step (or the workflow inputs)
 * offering any compatible source, then a matching name (output_image for input_image),
 * then an exact element type.
 */
export function preferredSource(sources, name, decl) {
  const origin = source => /^steps\.([^.]+)/.exec(source.ref)?.[1] ?? "";
  const last = sources.at(-1);
  if (!last) return undefined;
  const suffix = name.replace(/^input_/, "");
  const score = source => (source.ref.split(".").pop().replace(/^output_/, "") === suffix ? 2 : 0)
    + (source.type === elementType(decl.type) ? 1 : 0);
  return sources.filter(source => origin(source) === origin(last))
    .reduce((best, source) => (score(source) > score(best) ? source : best));
}

export function bindInput(doc, stepId, name, ref) {
  return withBinding(doc, stepId, name, ref ? { ref } : null);
}

/** Add a workflow input shaped like the tool's input and bind the step to it. */
export function bindNewWorkflowInput(doc, stepId, name, tool) {
  const decl = tool.inputs[name];
  const inputName = uniqueId(name.replace(/^input_/, ""), new Set(Object.keys(doc.inputs ?? {})));
  const input = { type: elementType(decl.type) };
  if (decl.formats) input.formats = [...decl.formats];
  if (decl.description) input.description = decl.description;
  return bindInput({ ...doc, inputs: { ...doc.inputs, [inputName]: input } }, stepId, name, `inputs.${inputName}`);
}

/** A parameter is written only when it differs from the tool default. */
export function setParameter(doc, stepId, name, value, tool) {
  const decl = tool.inputs[name];
  const unset = value === undefined || value === "" || (typeof value === "number" && Number.isNaN(value));
  return withBinding(doc, stepId, name, unset || value === decl?.default ? null : { constant: value });
}

export function outputKey(doc, stepId, name) {
  return Object.entries(doc.outputs ?? {}).find(([, output]) => output.ref === `steps.${stepId}.outputs.${name}`)?.[0];
}

export function setWorkflowOutput(doc, stepId, name, on, tool) {
  const outputs = { ...doc.outputs };
  const existing = outputKey(doc, stepId, name);
  if (!on) {
    if (existing) delete outputs[existing];
  } else if (!existing) {
    const key = uniqueId(name.replace(/^output_/, ""), new Set(Object.keys(outputs)));
    outputs[key] = { type: tool.outputs[name].type, ref: `steps.${stepId}.outputs.${name}` };
  }
  return { ...doc, outputs };
}

/** Remove a step, the bindings and outputs that read it, and inputs only it used. */
export function removeStep(doc, stepId) {
  const prefix = `steps.${stepId}.outputs.`;
  const { [stepId]: removed, ...rest } = doc.steps;
  if (!removed) return doc;
  const steps = Object.fromEntries(Object.entries(rest).map(([id, step]) => [id, {
    ...step,
    inputs: Object.fromEntries(Object.entries(step.inputs ?? {}).filter(([, binding]) => !binding.ref?.startsWith(prefix))),
  }]));
  const outputs = Object.fromEntries(Object.entries(doc.outputs ?? {}).filter(([, output]) => !output.ref?.startsWith(prefix)));
  return dropUnread({ ...doc, steps, outputs }, new Set(Object.values(removed.inputs ?? {}).map(binding => binding.ref)));
}

/** Issues keyed by step id; workflow-level issues are under "". */
export function issuesByStep(issues) {
  const grouped = new Map();
  for (const issue of issues) {
    const key = /^steps\.([^.]+)/.exec(issue.path ?? "")?.[1] ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(issue);
  }
  return grouped;
}

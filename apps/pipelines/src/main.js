// Pipeline Builder: compose the catalog's operations into a NeuroFlow workflow,
// validate it with the vendored NeuroFlow core and download it. Nothing runs here.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { APP, BUNDLE, VALIDATOR } from "./config.js";
import {
  addStep, addWorkflowInput, bindingSources, emptyWorkflow, exposedAs, isDataInput,
  moveStep, parseWorkflow, removeStep, setBinding, setExposed, toolLabel, usedTools,
} from "./workflow.js";
import { validateWorkflow } from "./validator.js";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Pipeline Builder",
  subtitle: "NeuroFlow workflows from the Neurodesk web apps",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// The viewer area shows the step list or the document; there is no image canvas.
const showView = (view) => {
  toolbar.setActive(view);
  $("stepsReport").hidden = view !== "steps" || !stepCount();
  $("jsonReport").hidden = view !== "json";
  $("emptyState").hidden = view === "json" || stepCount() > 0;
};
const toolbar = createViewerToolbar({
  views: [
    { id: "steps", label: "Steps", active: true, onClick: () => showView("steps") },
    { id: "json", label: "JSON", onClick: () => showView("json") },
  ],
  viewsLabel: "Workflow view",
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About Pipeline Builder", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

/** id → generated NeuroFlow tool, from the bundle the build wrote next to this page. */
const tools = new Map();
let library = [];
let catalogSummary = "";
let workflow = emptyWorkflow();
let report = { ok: false, issues: [] };
const stepCount = () => Object.keys(workflow.steps).length;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function loadCatalog() {
  const base = new URL(BUNDLE, location.href);
  const index = await (await fetch(base)).json();
  const documents = await Promise.all([...index.tools, ...index.workflows].map(async (path) => {
    const response = await fetch(new URL(path, base));
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }));
  const byApp = new Map();
  for (const tool of documents.filter((document) => document.kind === "tool")) {
    tools.set(tool.id, tool);
    const { contract } = tool.extensions["neurodesk/automation"];
    byApp.set(contract.title, [...(byApp.get(contract.title) ?? []), tool]);
  }
  $("toolSelect").replaceChildren(...[...byApp].sort(([a], [b]) => a.localeCompare(b)).map(([title, appTools]) =>
    element("optgroup", { label: title }, appTools.map((tool) => element("option", { value: tool.id, textContent: toolLabel(tool) })))));
  library = documents.filter((document) => document.kind === "workflow");
  $("library").append(...library.map((shipped, n) => element("option", { value: String(n), textContent: shipped.description })));
  $("toolSelect").disabled = $("addStep").disabled = $("library").disabled = false;
  showToolHint();
  catalogSummary = `${tools.size} tools from ${byApp.size} apps`;
}

function showToolHint() {
  $("toolHint").textContent = $("toolSelect").value;
}

function load(document, source) {
  workflow = document;
  $("fileInfo").hidden = !source;
  $("fileInfo").textContent = source ?? "";
  $("dropZone").classList.toggle("has-files", Boolean(source));
  return changed();
}

// --- The step list -------------------------------------------------------

const refLabel = (ref) => {
  const [kind, id, , port] = ref.split(".");
  if (kind === "inputs") return `Workflow input · ${id}`;
  return `${Object.keys(workflow.steps).indexOf(id) + 1} ${id} · ${port}`;
};

function issuesAt(path) {
  return report.issues.filter((issue) => issue.severity === "error" && (issue.path === path || issue.path?.startsWith(`${path}.`)));
}

function bindingControl(stepId, name, declaration) {
  const binding = workflow.steps[stepId].inputs[name];
  const select = element("select", { "aria-label": `${stepId} ${name}` });
  select.dataset.step = stepId;
  select.dataset.binding = name;
  const options = [element("option", { value: "", textContent: declaration.optional ? "Not set" : "Choose a source…" })];
  const sources = bindingSources(workflow, tools, stepId, declaration.type).filter((source) => source.compatible);
  if (binding?.ref && !sources.some((source) => source.ref === binding.ref)) sources.push({ ref: binding.ref });
  options.push(...sources.map((source) => element("option", { value: source.ref, textContent: refLabel(source.ref) })));
  if (binding && "constant" in binding) options.push(element("option", { value: "constant", textContent: `Constant · ${JSON.stringify(binding.constant)}` }));
  options.push(element("option", { value: "new", textContent: "New workflow input" }));
  select.replaceChildren(...options);
  select.value = binding?.ref ?? (binding && "constant" in binding ? "constant" : "");
  return select;
}

function settingControl(stepId, name, declaration) {
  const binding = workflow.steps[stepId].inputs[name];
  const value = binding && "constant" in binding ? binding.constant : undefined;
  const label = `${stepId} ${name}`;
  const defaulted = declaration.default === undefined ? "Default" : `Default (${declaration.default})`;
  let control;
  if (declaration.enum || declaration.type === "core:boolean") {
    const values = declaration.enum ?? [true, false];
    control = element("select", { "aria-label": label }, [
      element("option", { value: "", textContent: defaulted }),
      ...values.map((item) => element("option", { value: JSON.stringify(item), textContent: String(item) })),
    ]);
    control.value = value === undefined ? "" : JSON.stringify(value);
  } else if (declaration.type === "core:integer" || declaration.type === "core:number") {
    control = element("input", { type: "number", step: declaration.type === "core:integer" ? "1" : "any", placeholder: defaulted, value: value ?? "", "aria-label": label });
  } else if (declaration.type === "core:string") {
    control = element("input", { type: "text", placeholder: defaulted, value: value ?? "", "aria-label": label });
  } else {
    return element("span", { textContent: value === undefined ? "Set in the JSON" : JSON.stringify(value) });
  }
  control.dataset.step = stepId;
  control.dataset.setting = name;
  control.dataset.type = declaration.type;
  return control;
}

function table(caption, head, rows) {
  return element("div", { className: "nd-table-scroll" }, [element("table", { className: "nd-data-table" }, [
    element("caption", { textContent: caption }),
    element("thead", {}, [element("tr", {}, head.map((text) => element("th", { scope: "col", textContent: text })))]),
    element("tbody", {}, rows),
  ])]);
}

function row(cells, flagged) {
  const tr = element("tr", {}, cells.map((cell) => element("td", {}, [cell])));
  if (flagged) tr.dataset.flag = "error";
  return tr;
}

function stepSection(stepId, position) {
  const step = workflow.steps[stepId];
  const tool = tools.get(step.tool);
  const errors = issuesAt(`steps.${stepId}`);
  const button = (action, text, disabled = false) => {
    const node = element("button", { type: "button", className: "nd-btn nd-btn-secondary nd-btn-sm", textContent: text, disabled });
    node.dataset.action = action;
    node.dataset.step = stepId;
    return node;
  };
  const heading = element("div", { className: "nd-report-heading" }, [
    element("h3", { textContent: `${position + 1} · ${stepId} · ${tool ? toolLabel(tool) : step.tool}` }),
    ...(errors.length ? [element("span", { className: "nd-step-badge", textContent: `${errors.length} to fix` })] : []),
    button("up", "Up", position === 0),
    button("down", "Down", position === stepCount() - 1),
    button("remove", "Remove"),
  ]);
  if (!tool) {
    return element("section", {}, [heading, element("p", { className: "nd-report-notes", textContent: `${step.tool} is not in this catalog.` })]);
  }
  const entries = Object.entries(tool.inputs);
  const path = (name) => `steps.${stepId}.inputs.${name}`;
  const inputs = entries.filter(([, declaration]) => isDataInput(declaration)).map(([name, declaration]) =>
    row([element("span", { textContent: name }), element("span", { textContent: declaration.type }), bindingControl(stepId, name, declaration)], issuesAt(path(name)).length));
  const settings = entries.filter(([, declaration]) => !isDataInput(declaration)).map(([name, declaration]) =>
    row([element("span", { textContent: name, title: declaration.description ?? "" }), element("span", { textContent: declaration.type }), settingControl(stepId, name, declaration)], issuesAt(path(name)).length));
  const outputs = Object.entries(tool.outputs).map(([name, declaration]) => {
    const check = element("input", { type: "checkbox", checked: Boolean(exposedAs(workflow, stepId, name)), "aria-label": `Return ${stepId} ${name}` });
    check.dataset.step = stepId;
    check.dataset.expose = name;
    return row([element("span", { textContent: name }), element("span", { textContent: declaration.type }), check]);
  });
  return element("section", {}, [
    heading,
    element("p", { className: "nd-report-notes", textContent: tool.description }),
    table("Inputs", ["Input", "Type", "Bound to"], inputs),
    ...(settings.length ? [table("Settings", ["Setting", "Type", "Value"], settings)] : []),
    table("Outputs", ["Output", "Type", "Workflow output"], outputs),
  ]);
}

function render() {
  $("workflowId").value = workflow.id ?? "";
  $("workflowDescription").value = workflow.description ?? "";
  $("stepList").replaceChildren(...Object.keys(workflow.steps).map(stepSection));
  $("jsonPreview").textContent = JSON.stringify(workflow, null, 2);
  $("runButton").disabled = !report.ok || !stepCount();
  showView($("jsonReport").hidden ? "steps" : "json");
}

// --- Validation ------------------------------------------------------------

let generation = 0;
async function changed() {
  const current = ++generation;
  render();
  if (!stepCount()) {
    report = { ok: false, issues: [] };
    render();
    if (tools.size) status(`${catalogSummary} · add a step to start a workflow`);
    return report;
  }
  const result = await validateWorkflow(workflow, usedTools(workflow, tools));
  if (current !== generation) return result;
  report = result;
  render();
  const errors = result.issues.filter((issue) => issue.severity === "error");
  for (const issue of errors) log.log(`${issue.path ?? "workflow"}: ${issue.message}`, "error");
  status(result.ok ? `Valid workflow · ${stepCount()} steps` : `${errors.length} to fix before export · see the console`, !result.ok);
  return result;
}

// --- Events --------------------------------------------------------------------

$("toolSelect").addEventListener("change", showToolHint);
$("addStep").addEventListener("click", () => {
  const tool = tools.get($("toolSelect").value);
  if (!tool) return;
  const id = addStep(workflow, tools, tool);
  log.log(`Added ${id}: ${tool.id}`, "info");
  $("library").value = "";
  changed();
});
$("library").addEventListener("change", () => {
  const shipped = library[Number($("library").value)];
  load(shipped ? structuredClone(shipped) : emptyWorkflow(), null);
});
$("workflowId").addEventListener("change", () => { workflow.id = $("workflowId").value.trim(); changed(); });
$("workflowDescription").addEventListener("change", () => { workflow.description = $("workflowDescription").value.trim(); changed(); });

$("stepList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, step } = button.dataset;
  if (action === "remove") removeStep(workflow, step);
  else moveStep(workflow, step, action === "up" ? -1 : 1);
  changed();
});
$("stepList").addEventListener("change", (event) => {
  const target = event.target;
  const { step } = target.dataset;
  if (target.dataset.binding) {
    const name = target.dataset.binding;
    if (target.value === "constant") return;
    const ref = target.value === "new" ? addWorkflowInput(workflow, name, tools.get(workflow.steps[step].tool).inputs[name]) : target.value;
    setBinding(workflow, step, name, ref ? { ref } : null);
  } else if (target.dataset.setting) {
    const raw = target.value.trim();
    const constant = raw === "" ? undefined
      : target.tagName === "SELECT" ? JSON.parse(raw)
        : target.dataset.type === "core:string" ? raw : Number(raw);
    setBinding(workflow, step, target.dataset.setting, constant === undefined ? null : { constant });
  } else if (target.dataset.expose) {
    setExposed(workflow, tools, step, target.dataset.expose, target.checked);
  }
  changed();
});

$("runButton").addEventListener("click", () => {
  if (!report.ok) return;
  const name = `${workflow.id.split("/").pop() || "pipeline"}.workflow.json`;
  downloadFile(new File([`${JSON.stringify(workflow, null, 2)}\n`], name, { type: "application/json" }));
  progress.end(`Exported ${name}`);
  status(`Exported ${name}`);
});

async function openFiles(filesPromise) {
  const files = await filesPromise;
  if (files.length !== 1) throw new Error("Open one .workflow.json file.");
  const document = parseWorkflow(await files[0].text());
  $("library").value = "";
  return load(document, files[0].name);
}
const importFiles = (files) => openFiles(files).catch((error) => status(error.message, true));
$("workflowInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);

const catalog = loadCatalog().then(changed).catch((error) => status(`Could not load the tool catalog: ${error.message}`, true));

registerAppAutomation({
  app: APP.id,
  operations: {
    validate: async ({ inputs, signal }) => {
      await catalog;
      signal?.throwIfAborted();
      const result = await openFiles(Promise.resolve(inputs.workflow));
      return {
        artifacts: [{ role: "validation", file: new File([`${JSON.stringify(result, null, 2)}\n`], "validation.json", { type: "application/json" }) }],
        provenance: { validator: `${VALIDATOR.source}@${VALIDATOR.commit}`, valid: result.ok, scientificProcessing: false },
      };
    },
  },
});

export default Object.freeze({ workspace, toolbar, log, info });

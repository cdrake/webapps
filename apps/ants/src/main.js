import examples from '../examples.json';
import templateCatalogue from '../../../registry/templates.json';
import { bindInfoTooltips } from '@neurodesk/webapp-components/ui';
import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createImagePair, templatesFor, createResultList, createInfoDialog, renderCommand, createConsole, createViewerToolbar } from "@neurodesk/webapp-components/ui";
import { describeNiftiFile, downloadFile } from "@neurodesk/webapp-components/file-io";
import { artifactFiles } from "@neurodesk/ants/outputs";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, registerViewer, createNiivueAdapter } from "@neurodesk/webapp-components/automation";
import { extractBrain } from "./brain-extraction.js";
import { createRegistrationRunner } from "./registration-runner.js";

const $ = (id) => document.getElementById(id);
const extractButtons = { fixed: $("fixedExtractButton"), moving: $("movingExtractButton") };
const viewers = {
  fixed: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  moving: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  resliced: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let currentLayout = "multiplanar";
let output = null;
let outputs = {};
let busy = false;
let viewersReady = false;
let viewersDestroyed = false;
let timer;

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "ANTs",
  subtitle: "Browser-native SyN registration with ANTs",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn", standalone: "#standaloneBtn" },
});

function applyLayout(id) {
  if (!viewersReady) return;
  currentLayout = id;
  for (const viewer of Object.values(viewers)) {
    if (id === "multiplanar") {
      viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
      viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
      viewer.showRender = SHOW_RENDER.ALWAYS;
    } else {
      viewer.sliceType = {
        axial: SLICE_TYPE.AXIAL,
        coronal: SLICE_TYPE.CORONAL,
        sagittal: SLICE_TYPE.SAGITTAL,
        render: SLICE_TYPE.RENDER,
      }[id];
    }
    viewer.drawScene();
  }
}

const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    ["multiplanar", "3-Plane"],
    ["axial", "Axial"],
    ["coronal", "Coronal"],
    ["sagittal", "Sagittal"],
    ["render", "3D"],
  ].map(([id, label], index) => ({ id, label, active: index === 0, onClick: () => { applyLayout(id); toolbar.setActive(id); } })),
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog" });
bindInfoTooltips(document);
$("viewer").append(log);
const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About ANTs", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));
$("standaloneBtn").onclick = () => {
  info.open("Run ANTs in a terminal", $("standaloneContent"));
  info.body.append(renderCommand({
    id: "antsStandaloneCommands",
    command: [
      "antsRegistration --dimensionality 3 --float 1 --random-seed 42 \\",
      "  -r [fixed.nii.gz,moving.nii.gz,1] \\",
      "  --metric mattes[fixed.nii.gz,moving.nii.gz,1,32,regular,0.2] --transform Affine[0.25] \\",
      "  --convergence 2100x1200x1200x0 --smoothing-sigmas 3x2x1x0 --shrink-factors 4x2x2x1 \\",
      "  --metric mattes[fixed.nii.gz,moving.nii.gz,1,32] --transform SyN[0.2,3,0] \\",
      "  --convergence [40x20x0,1e-7,8] --smoothing-sigmas 2x1x0 --shrink-factors 4x2x1 \\",
      "  -u 0 -z 1 --output [result-,registered.nii.gz]",
      "antsApplyTransforms -d 3 -i moving.nii.gz -r fixed.nii.gz -o registered.nii.gz \\",
      "  -t result-1Warp.nii.gz -t result-0GenericAffine.mat",
    ].join("\n"),
  }).root);
};

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown error");
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function setBusy(value) {
  busy = value;
  const disabled = value || !viewersReady;
  pair.disabled = disabled;
  for (const [slot, button] of Object.entries(extractButtons)) {
    button.disabled = disabled || !pair[slot] || pair[slot].image.brainExtracted;
  }
  $("runButton").disabled = disabled || !pair.ready;
  if (!value) {
    clearInterval(timer);
    $("elapsed").textContent = "";
    $("cancelButton").hidden = true;
  }
}

function fmtIntensity(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

function fmtMm(mm = []) {
  return mm.map((value) => Math.round(value)).join("×");
}

let fixedValue = null;
let reslicedValue = null;
let yokedMm = [];

function renderYokedLocation() {
  $("location").textContent = `${fmtMm(yokedMm)} mm  Fixed ${fmtIntensity(fixedValue)} · Resliced ${fmtIntensity(reslicedValue)}`;
}

async function configureViewer(name, canvasId, onLocation) {
  const viewer = viewers[name];
  await viewer.attachTo(canvasId);
  viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
  viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
  viewer.showRender = SHOW_RENDER.ALWAYS;
  viewer.crosshairGap = 5;
  viewer.isLegendVisible = false;
  viewer.is3DCrosshairVisible = true;
  viewer.meshXRay = 0.08;
  const context = viewer.createExtensionContext();
  context.on("locationChange", (event) => onLocation(event.detail));
  contexts.push(context);
}

async function attachViewers() {
  await configureViewer("fixed", "glFixed", (detail) => {
    fixedValue = detail.values[0]?.value ?? null;
    yokedMm = detail.mm;
    renderYokedLocation();
  });
  await configureViewer("moving", "glMoving", (detail) => {
    $("location").textContent = `${fmtMm(detail.mm)} mm  Moving ${fmtIntensity(detail.values[0]?.value)}`;
  });
  await configureViewer("resliced", "glResliced", (detail) => {
    reslicedValue = detail.values[0]?.value ?? null;
    yokedMm = detail.mm;
    renderYokedLocation();
  });
  viewers.fixed.broadcastTo([viewers.resliced]);
  viewers.resliced.broadcastTo([viewers.fixed]);
  viewersReady = true;
}

function destroyViewers() {
  if (viewersDestroyed) return;
  viewersDestroyed = true;
  viewersReady = false;
  for (const context of contexts.splice(0)) {
    try { context.dispose(); } catch { /* best-effort cleanup */ }
  }
  for (const viewer of Object.values(viewers)) {
    try { viewer.destroy(); } catch { /* best-effort cleanup */ }
  }
}

async function clearOutput() {
  output = null;
  outputs = {};
  reslicedValue = null;
  $("outputSection").open = false;
  $("resultList").replaceChildren();
  $("progress").value = 0;
  await viewers.resliced.removeAllVolumes();
}

async function perform(message, task) {
  if (busy) throw new Error("Wait for the current operation to finish.");
  setBusy(true);
  status(message);
  try {
    return await task();
  } finally {
    setBusy(false);
  }
}

async function runTask(message, task) {
  try {
    await perform(message, task);
  } catch (error) {
    status(errorMessage(error), true);
  }
}

const pair = createImagePair({
  examples,
  templates: templatesFor(templateCatalogue, "ants"),
  read: async (files) => (await readImageFiles(files)).map((file) => ({ name: file.name, file })),
  open: async (slot, candidate, { signal }) => {
    if (!viewersReady) throw new Error("The image viewers are not ready. Try again after initialization.");
    await viewers[slot].loadVolumes([{ url: candidate.file, name: candidate.file.name }]);
    signal?.throwIfAborted();
    $("emptyState").hidden = true;
    const brainExtracted = candidate.brainExtracted ?? false;
    return { ...await describeNiftiFile(candidate.file), brainExtracted, note: brainExtracted ? "brain extracted" : "not brain extracted" };
  },
  clear: (slot) => viewers[slot].removeAllVolumes(),
  perform,
  onStatus: status,
  onChange: ({ slot, [slot]: state }) => {
    void clearOutput();
    setBusy(busy);
    if (state) status(`${state.image.name} loaded as the ${slot} image.`);
  },
});
$("imagePair").replaceWith(pair);
pair.disabled = true;
for (const [slot, button] of Object.entries(extractButtons)) {
  button.onclick = () => void runTask(`Brain extracting the ${slot} image…`, () => brainExtract(slot));
}

async function brainExtract(name) {
  const state = pair[name];
  if (!state || state.image.brainExtracted) return;
  const source = state.candidate.file;
  status(`Brain extracting ${source.name} with MindGrab…`);
  $("progress").removeAttribute("value");
  const result = await extractBrain({
    file: source,
    assetPath: `${import.meta.env.BASE_URL}brainchop/`,
    onLog: (message) => log.log(message),
  });
  await pair.useWithin(name, { name: result.file.name, file: result.file, brainExtracted: true });
  status(`${source.name} brain extracted in ${(result.elapsedMs / 1000).toFixed(1)} s (${result.backend}).`);
  $("progress").value = 0;
}

const RESULTS = {
  registered: { description: "Registered moving image" },
  affine: { description: "Affine transform (.mat)" },
  warp: { description: "Forward warp" },
  "inverse-warp": { description: "Inverse warp" },
};
const results = createResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: (stage) => downloadFile(outputs[stage]),
});

const registration = createRegistrationRunner({
  createWorker: () => new Worker(new URL("./registration-worker.js", import.meta.url), { type: "module" }),
  onLog: (line) => log.log(line),
  onActiveChange: (active) => { $("cancelButton").hidden = !active; },
});

async function register({
  moving = pair.moving?.candidate.file,
  fixed = pair.fixed?.candidate.file,
  signal,
  progress = () => {},
} = {}) {
  if (!moving || !fixed) throw new Error("Choose both moving and fixed images.");
  signal?.throwIfAborted();
  // Extraction is the user's call; a scalp-bearing input is only flagged, not forced.
  for (const name of ["fixed", "moving"]) {
    if (!pair[name]?.image.brainExtracted) log.log(`The ${name} image is not brain extracted; scalp can distort the registration.`);
  }
  const started = performance.now();
  let phase = "Starting ANTs registration";
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    $("statusText").textContent = phase;
  }, 1000);
  $("progress").removeAttribute("value");
  try {
    const data = await registration.run(fixed, moving, (next) => {
      phase = next;
      status(next);
      progress({ message: next });
    }, signal);
    signal?.throwIfAborted();
    const files = artifactFiles(moving.name, { warped: data.image, transforms: data.transforms });
    outputs = Object.fromEntries(files.map(({ role, name, bytes }) => [role, new File([bytes], name)]));
    output = outputs.registered;
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    signal?.throwIfAborted();
    results.render(RESULTS);
    $("outputSection").open = true;
    $("progress").value = 1;
    status(`Registration complete in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    return {
      artifacts: Object.entries(outputs).map(([role, file]) => ({ role, file })),
      provenance: { algorithm: "ANTs SyN", implementation: "@neurodesk/registration", seed: 42, affineIterations: "2100x1200x1200x0", synIterations: "40x20x0", elapsedMs: performance.now() - started },
    };
  } catch (error) {
    $("progress").value = 0;
    signal?.throwIfAborted();
    if (error?.name === "AbortError" || errorMessage(error) === "Cancelled") {
      status("Registration cancelled. Your images are unchanged.");
      return;
    }
    throw new Error(`Registration failed: ${errorMessage(error)}`);
  }
}

$("runButton").onclick = () => void runTask("Starting registration…", async () => {
  await clearOutput();
  await register();
});
$("cancelButton").onclick = () => {
  status("Cancelling registration…");
  registration.cancel();
};

async function init() {
  if (!navigator.gpu) {
    setBusy(false);
    status("WebGPU is unavailable. ANTs needs a recent desktop browser.", true);
    return;
  }
  await runTask("Initializing image viewers…", async () => {
    try {
      await attachViewers();
    } catch (error) {
      destroyViewers();
      $("viewerError").hidden = false;
      $("viewerError").textContent = `Visualization unavailable: ${errorMessage(error)}`;
      throw error;
    }
    status("Drag and drop files");
  });
}

window.addEventListener("pagehide", () => {
  pair.exampleControl?.destroy();
  clearInterval(timer);
  registration.terminate();
  destroyViewers();
});

const initialization = init();

registerAppAutomation({
  app: "ants",
  convertDicom: runDcm2niix,
  operations: {
    register: async ({ inputs, parameters, signal, progress }) => {
      await initialization;
      signal.throwIfAborted();
      if (!viewersReady) throw new Error("The image viewers are unavailable.");
      if (busy) throw new Error("Wait for the current operation to finish.");
      pair.exampleControl?.reset();
      setBusy(true);
      try {
        await pair.useWithin("fixed", { name: inputs.fixed[0].name, file: inputs.fixed[0] }, signal);
        await pair.useWithin("moving", { name: inputs.moving[0].name, file: inputs.moving[0] }, signal);
        const result = await register({ moving: inputs.moving[0], fixed: inputs.fixed[0], signal, progress });
        signal.throwIfAborted();
        if (!result) throw new DOMException("Registration cancelled", "AbortError");
        return result;
      } finally {
        setBusy(false);
      }
    },
  },
});

for (const [id, viewer] of Object.entries(viewers)) {
  registerViewer(id, createNiivueAdapter(viewer, {
    tabs: {
      list: () => ["multiplanar", "axial", "coronal", "sagittal", "render"].map((id) => ({ id, label: id, active: id === currentLayout })),
      select: (id) => { applyLayout(id); toolbar.setActive(id); },
    },
  }));
}

export default Object.freeze({ toolbar, log, info, results });

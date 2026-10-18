import examples from '../examples.json';
import templateCatalogue from '../../../registry/templates.json';
import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import { Niimath } from "@niivue/niimath";
import { OUTPUT_DATA_TYPE, registeredName, registrationChain } from "@neurodesk/edgereg";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createImagePair, templatesFor, createResultList, createInfoDialog, createConsole, createViewerToolbar } from "@neurodesk/webapp-components/ui";
import { describeNiftiFile, downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, registerViewer, createNiivueAdapter } from "@neurodesk/webapp-components/automation";

const $ = (id) => document.getElementById(id);
const viewers = {
  fixed: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  moving: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  resliced: new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let currentLayout = "multiplanar";
let output = null;
let busy = false;
let cancelled = false;
let viewersReady = false;
let viewersDestroyed = false;
let niimath = new Niimath();
let niimathReady;
let timer;

niimath.setOutputDataType(OUTPUT_DATA_TYPE);

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "EdgeReg",
  subtitle: "Browser-native affine MRI registration",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
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
$("viewer").append(log);
const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About EdgeReg", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

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
  $("robustFov").disabled = disabled;
  $("runButton").disabled = disabled || !pair.ready;
  $("cancelButton").hidden = true;
  if (!value) {
    clearInterval(timer);
    $("elapsed").textContent = "";
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

function resetNiimath() {
  niimath.dispose();
  niimath = new Niimath();
  niimath.setOutputDataType(OUTPUT_DATA_TYPE);
  niimathReady = undefined;
}

async function clearOutput() {
  output = null;
  reslicedValue = null;
  $("outputSection").open = false;
  $("resultList").replaceChildren();
  $("progress").value = 0;
  await viewers.resliced.removeAllVolumes();
}

async function perform(message, task) {
  if (busy) throw new Error("Wait for the current operation to finish.");
  cancelled = false;
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
  templates: templatesFor(templateCatalogue, "edgereg"),
  read: async (files) => (await readImageFiles(files)).map((file) => ({ name: file.name, file })),
  open: async (slot, candidate, { signal }) => {
    if (!viewersReady) throw new Error("The image viewers are not ready. Try again after initialization.");
    await viewers[slot].loadVolumes([{ url: candidate.file, name: candidate.file.name }]);
    signal?.throwIfAborted();
    $("emptyState").hidden = true;
    return describeNiftiFile(candidate.file);
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

const results = createResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: () => downloadFile(output),
});

async function register({
  moving = pair.moving?.candidate.file,
  fixed = pair.fixed?.candidate.file,
  robustFov = $("robustFov").checked,
  signal,
  progress = () => {},
} = {}) {
  if (!moving || !fixed) throw new Error("Choose both moving and fixed images.");
  signal?.throwIfAborted();
  const abort = () => { cancelled = true; resetNiimath(); };
  signal?.addEventListener("abort", abort, { once: true });
  const started = performance.now();
  timer = setInterval(() => { $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`; }, 1000);
  status("Registering the moving image to the fixed image…");
  progress({ message: "Registering the moving image to the fixed image" });
  $("progress").removeAttribute("value");
  $("cancelButton").hidden = false;
  try {
    niimathReady ||= niimath.init();
    await niimathReady;
    signal?.throwIfAborted();
    if (cancelled) return;
    const blob = await registrationChain(niimath.image(moving), fixed, { robustFov }).run("registered.nii");
    signal?.throwIfAborted();
    if (cancelled) return;
    output = new File([blob], registeredName(moving.name));
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    signal?.throwIfAborted();
    if (cancelled) {
      await clearOutput();
      return;
    }
    results.render({ registered: { description: "Registered moving image" } });
    $("outputSection").open = true;
    $("progress").value = 1;
    status("Registration complete");
    return {
      artifacts: [{ role: "registered", file: output }],
      provenance: { algorithm: "niimath allineate", robustFov, elapsedMs: performance.now() - started },
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (cancelled) return;
    resetNiimath();
    $("progress").value = 0;
    throw new Error(`Registration failed: ${errorMessage(error)}`);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function reregister() {
  await clearOutput();
  await register();
}

$("runButton").onclick = () => void runTask("Starting registration…", reregister);
$("robustFov").onchange = () => void runTask("Updating registration…", reregister);

$("cancelButton").onclick = () => {
  cancelled = true;
  resetNiimath();
  $("cancelButton").hidden = true;
  $("progress").value = 0;
  status("Registration cancelled. Your images are unchanged.");
};

async function init() {
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
  niimath.dispose();
  destroyViewers();
});

const initialization = init();

registerAppAutomation({
  app: "edgereg",
  convertDicom: runDcm2niix,
  operations: {
    register: async ({ inputs, parameters, signal, progress }) => {
      await initialization;
      signal.throwIfAborted();
      if (!viewersReady) throw new Error("The image viewers are unavailable.");
      if (busy) throw new Error("Wait for the current operation to finish.");
      pair.exampleControl?.reset();
      cancelled = false;
      setBusy(true);
      try {
        await pair.useWithin("fixed", { name: inputs.fixed[0].name, file: inputs.fixed[0] }, signal);
        await pair.useWithin("moving", { name: inputs.moving[0].name, file: inputs.moving[0] }, signal);
        $("robustFov").checked = parameters.robustFov;
        const result = await register({ moving: inputs.moving[0], fixed: inputs.fixed[0], robustFov: parameters.robustFov, signal, progress });
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

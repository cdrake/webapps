import examples from '../examples.json';
import templateCatalogue from '../../../registry/templates.json';
import { bindInfoTooltips } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import { register as registerFireants } from "@fireants/fireants";
import { registeredFileName } from "@neurodesk/fireants/outputs";
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createImagePair, templatesFor, createResultList, createInfoDialog, createConsole, createViewerToolbar } from "@neurodesk/webapp-components/ui";
import { describeNiftiFile, downloadFile } from "@neurodesk/webapp-components/file-io";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, registerViewer, createNiivueAdapter } from "@neurodesk/webapp-components/automation";
import { extractBrain } from "./brain-extraction.js";
import { formatBytes, startMemorySampler } from "./memory.js";

const $ = (id) => document.getElementById(id);
const extractButtons = { fixed: $("fixedExtractButton"), moving: $("movingExtractButton") };
const viewers = {
  fixed: new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  moving: new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
  resliced: new NiiVue({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] }),
};
const contexts = [];
let currentLayout = "multiplanar";
let output = null;
let busy = false;
let viewersReady = false;
let viewersDestroyed = false;
let registrationController = null;
let timer;

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "FireANTs",
  subtitle: "CPU and WebGPU diffeomorphic MRI registration",
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
bindInfoTooltips(document);
$("viewer").append(log);
const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About FireANTs", $("aboutContent"));
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
  for (const [slot, button] of Object.entries(extractButtons)) {
    button.disabled = disabled || !pair[slot] || pair[slot].image.brainExtracted;
  }
  $("useGpu").disabled = disabled || !navigator.gpu;
  $("useSyn").disabled = disabled;
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
  templates: templatesFor(templateCatalogue, "fireants"),
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

const results = createResultList({
  element: $("resultList"),
  onView: () => viewers.resliced.drawScene(),
  onDownload: () => downloadFile(output),
});

const CPU_TIMEOUT_MS = 45 * 60 * 1000;
let progressStage = "";

// Engine log lines look like "--- Stage 1: Rigid (...) ---", "  Scale 4: fixed[...] x 200 iters"
// and "    iter 50/200 loss=...". Turn them into one short status line per update.
function describeProgress(line) {
  const stage = /^--- Stage \d+: (\w+)/.exec(line.trim());
  if (stage) {
    progressStage = stage[1];
    return `${progressStage} stage…`;
  }
  const scale = /^\s*Scale (\d+):.*?(\d+) iters/.exec(line);
  if (scale) return `${progressStage || "Registration"} · scale ${scale[1]} · ${scale[2]} iterations`;
  const iter = /^\s*iter (\d+)\/(\d+)/.exec(line);
  if (iter) return `${progressStage || "Registration"} · iteration ${iter[1]} of ${iter[2]}`;
  return null;
}

async function runRegistration(fixed, moving, backend, transform, onProgress, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  registrationController = controller;
  $("cancelButton").hidden = false;
  try {
    const [fixedBytes, movingBytes] = await Promise.all([fixed.arrayBuffer(), moving.arrayBuffer()]);
    return await registerFireants(fixedBytes, movingBytes, {
      assetPath: `${import.meta.env.BASE_URL}cfireants/`,
      backend,
      transform,
      worker: true,
      signal: controller.signal,
      gzip: true,
      verbose: 2,
      // CPU registration of 1 mm whole-brain images can take well over the engine's default 15 minutes.
      timeoutMs: backend === "cpu" ? CPU_TIMEOUT_MS : undefined,
      onLog: (line) => {
        log.log(line);
        const message = describeProgress(line);
        if (message) onProgress(message);
      },
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    if (registrationController === controller) registrationController = null;
    $("cancelButton").hidden = true;
  }
}

function logMemory(backend, memory) {
  if (!memory) {
    log.log(`Peak sampled page RAM (${backend}): unavailable in this browser.`);
    return;
  }
  let message = `Peak sampled page RAM (${backend}): ${formatBytes(memory.bytes)}`;
  if (backend === "webgpu") {
    message += memory.gpuBytes
      ? ` · GPU-attributed memory: ${formatBytes(memory.gpuBytes)}`
      : " · GPU-attributed memory: unavailable";
  }
  log.log(message);
}

async function register({
  moving = pair.moving?.candidate.file,
  fixed = pair.fixed?.candidate.file,
  backend = $("useGpu").checked ? "webgpu" : "cpu",
  transform = $("useSyn").checked ? "syn" : "greedy",
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
  progressStage = "";
  let phase = `Starting ${transform} registration on ${backend}`;
  timer = setInterval(() => {
    $("elapsed").textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    $("statusText").textContent = phase;
  }, 1000);
  $("progress").removeAttribute("value");
  const stopMemorySampler = startMemorySampler();
  try {
    const data = await runRegistration(fixed, moving, backend, transform, (next) => {
      phase = next;
      status(next);
      progress({ message: next });
    }, signal);
    signal?.throwIfAborted();
    output = new File([data.image], registeredFileName(moving.name));
    await viewers.resliced.loadVolumes([{ url: output, name: output.name }]);
    signal?.throwIfAborted();
    results.render({ registered: { description: "Registered moving image" } });
    $("outputSection").open = true;
    $("progress").value = 1;
    const endToEnd = ((performance.now() - started) / 1000).toFixed(1);
    const engine = (data.elapsedMs / 1000).toFixed(1);
    const execution = data.variant === "mt" ? `${data.threads} CPU threads` : data.variant === "gpu" ? "WebGPU" : "1 CPU thread";
    status(`Registration complete in ${endToEnd} s end to end · ${engine} s engine · ${execution}`);
    return {
      artifacts: [{ role: "registered", file: output }],
      provenance: { algorithm: "FireANTs", backend, transform, variant: data.variant, threads: data.threads, engineElapsedMs: data.elapsedMs, elapsedMs: performance.now() - started },
    };
  } catch (error) {
    $("progress").value = 0;
    signal?.throwIfAborted();
    if (error?.code === "aborted") {
      status("Registration cancelled. Your images are unchanged.");
      return;
    }
    throw new Error(`Registration failed: ${errorMessage(error)}`);
  } finally {
    logMemory(backend, await stopMemorySampler());
  }
}

$("runButton").onclick = () => void runTask("Starting registration…", async () => {
  await clearOutput();
  await register();
});
$("useGpu").onchange = () => void runTask("Changing registration backend…", clearOutput);
$("useSyn").onchange = () => void runTask("Changing registration algorithm…", clearOutput);
$("cancelButton").onclick = () => {
  status("Cancelling registration…");
  registrationController?.abort();
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
  registrationController?.abort();
  destroyViewers();
});

const initialization = init();

registerAppAutomation({
  app: "fireants",
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
        $("useGpu").checked = parameters.backend === "webgpu";
        $("useSyn").checked = parameters.transform === "syn";
        const result = await register({ moving: inputs.moving[0], fixed: inputs.fixed[0], backend: parameters.backend, transform: parameters.transform, signal, progress });
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

import examples from '../examples.json';
import appPackage from '../package.json';
import { createRunState, summarizeLabels } from '@neurodesk/webapp-components/automation';
import { createExampleSelector } from '@neurodesk/webapp-components/ui';
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from '@niivue/niivue';
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace';
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
} from '@neurodesk/webapp-components/ui';
import { downloadBlob, downloadFile, readNifti } from '@neurodesk/webapp-components/file-io';
import { readImageFiles } from '@neurodesk/runtime-support/dcm2niix-client';
import manifest from '@neurodesk/synthseg/manifest';
import { looksLikeCt, outputStem } from './logic.js';
import freesurferLut from './freesurfer-lut.json';
import './styles.css';

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'SynthSeg',
  subtitle: 'FreeSurfer brain labels, in your browser',
  mark: 'S',
  controlsContract: { privacy: '#privacyBtn', standalone: '#standaloneBtn' },
});
const $ = (id) => document.getElementById(id);
const technicalLog = createConsole({ id: 'technicalLog' });
$('viewer').append(technicalLog);
const runs = createRunState({ app: 'synthseg', appVersion: appPackage.version });
const info = createInfoDialog({ id: 'infoDialog' });
const layouts = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const toolbar = createViewerToolbar({
  window: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: 'multiplanar', label: '3-Plane', active: true },
    { id: 'axial', label: 'Axial' },
    { id: 'coronal', label: 'Coronal' },
    { id: 'sagittal', label: 'Sagittal' },
    { id: 'render', label: '3D' },
  ].map((view) => ({
    ...view,
    onClick: () => {
      if (!viewer) return;
      viewer.sliceType = layouts[view.id];
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
$('viewer').prepend(toolbar);
toolbar.control('overlayOpacity').id = 'opacity';
$('opacity').value = '0.6';
$('opacity').disabled = true;
toolbar.control('overlayOpacityValue').textContent = '60%';
const results = createResultList({
  element: $('resultList'),
  onView: () => {
    if (output && !busy) void show();
  },
  onDownload: () => {
    if (output && !busy) downloadFile(output);
  },
});
results.render({ labels: { description: 'FreeSurfer labels' } });
$('resultList').querySelector('.nd-download-btn').id = 'saveBtn';
$('resultList').querySelector('.nd-view-btn').id = 'viewResultBtn';
$('saveBtn').disabled = true;
$('viewResultBtn').disabled = true;
const assetBase = import.meta.env.VITE_SYNTHSEG_ASSET_BASE || manifest.base_url;

const webgpu = Boolean(navigator.gpu);
let source,
  output,
  provenance,
  worker,
  viewer,
  viewerReady,
  busy = false,
  timer,
  started;
let operation;
let viewRevision = 0;
let importedImages = [];

function status(message, error = false) {
  $('statusText').textContent = message;
  $('statusText').classList.toggle('error', error);
  technicalLog.log(message, error ? 'error' : 'info');
  runs.message(message);
}
function setBusy(value, cancellable = false) {
  busy = value;
  exampleControl.setDisabled(value);
  for (const id of ['imageInput', 'seriesSelect', 'mode', 'ct'])
    $(id).disabled = value;
  $('processButton').disabled = value || !source || !webgpu;
  $('cancelBtn').hidden = !value || !cancellable;
  $('opacity').disabled = value || !output;
  $('saveBtn').disabled = value || !output;
  $('viewResultBtn').disabled = value || !output;
  $('reportBtn').disabled = value || runs.snapshot().state !== 'succeeded';
  if (!value) {
    clearInterval(timer);
    worker?.terminate();
    worker = null;
  }
}
async function ensureViewer() {
  if (viewerReady) return viewerReady;
  viewerReady = (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false, backgroundColor: [0.04, 0.06, 0.08, 1] });
    await viewer.attachTo('gl1');
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.showRender = SHOW_RENDER.ALWAYS;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on('locationChange', (e) => {
      $('location').textContent = e.detail.string;
    });
    return viewer;
  })();
  return viewerReady;
}
async function show() {
  const revision = ++viewRevision;
  const displayedOutput = output;
  $('emptyState').hidden = true;
  $('imageLabel').textContent = output ? 'ORIGINAL IMAGE · FREESURFER LABELS' : 'ORIGINAL IMAGE';
  const volumes = [{ url: source, name: source.name }];
  if (output) volumes.push({ url: output, name: output.name, opacity: Number($('opacity').value) });
  try {
    const nv = await ensureViewer();
    if (revision !== viewRevision) return;
    await nv.loadVolumes(volumes);
    if (revision !== viewRevision) return;
    // Label names too, so the location bar reads e.g. "Left-Hippocampus".
    if (displayedOutput) await nv.setColormapLabel(1, freesurferLut);
    if (revision !== viewRevision) return;
    $('viewerError').hidden = true;
  } catch (error) {
    if (revision !== viewRevision) return;
    $('viewerError').hidden = false;
    $('viewerError').textContent =
      `Visualization unavailable: ${error.message}. Processing and NIfTI download remain available.`;
  }
}
function clearOutputs() {
  output = null;
  provenance = null;
  $('outputSection').open = false;
  $('reportBtn').disabled = true;
  $('saveBtn').disabled = true;
  $('viewResultBtn').disabled = true;
}
function beginImport() {
  operation = runs.begin('loading');
  source = null;
  ++viewRevision;
  clearOutputs();
  $('fileInfo').hidden = true;
  setBusy(true, true);
  return operation;
}
async function load(file, signal, existingRun) {
  if ((!existingRun && busy) || !file) return false;
  const run = existingRun || beginImport();
  const abort = () => {
    if (operation !== run) return;
    cancel();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error('Choose a .nii or .nii.gz image.');
    status('Reading image…');
    const { data, dims } = await readNifti(await file.arrayBuffer());
    signal?.throwIfAborted();
    run.signal.throwIfAborted();
    if (!run.current) return false;
    source = file;
    $('ct').checked = looksLikeCt(data);
    $('progress').value = 0;
    $('elapsed').textContent = '';
    $('fileInfo').hidden = false;
    $('fileInfo').textContent = `${file.name} · ${dims.join(' × ')} voxels`;
    void show();
    if (webgpu) run.ready('Image loaded · ready to segment');
    else run.fail('Image loaded · this browser cannot run SynthSeg');
    status(
      webgpu
        ? 'Image loaded · ready to segment'
        : 'Image loaded · this browser cannot run SynthSeg',
      !webgpu,
    );
    return true;
  } catch (error) {
    if (run.fail(error)) status(error.message, true);
    return false;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (operation === run) setBusy(false);
  }
}
async function importImages(filesPromise) {
  exampleControl.cancel();
  if (busy) return;
  const run = beginImport();
  status('Reading images · converting DICOM if needed…');
  try {
    const files = await filesPromise;
    run.signal.throwIfAborted();
    const images = await readImageFiles(files, { signal: run.signal });
    run.signal.throwIfAborted();
    if (!images.length) throw new Error('Choose NIfTI files or a complete DICOM series.');
    if (!(await load(images[0], undefined, run)) || operation !== run) return;
    importedImages = images;
    $('seriesSelect').replaceChildren(
      ...images.map((file, index) => new Option(file.name, String(index))),
    );
    $('seriesSelect').hidden = images.length < 2;
  } catch (error) {
    if (run.fail(error)) {
      setBusy(false);
      status(error.message, true);
    }
  } finally {
    if (operation === run) setBusy(false);
  }
}
$('imageInput').onchange = () => {
  const files = Array.from($('imageInput').files);
  $('imageInput').value = '';
  if (files.length) void importImages(Promise.resolve(files));
};
$('seriesSelect').onchange = async () => {
  if (!(await load(importedImages[Number($('seriesSelect').value)])))
    $('seriesSelect').value = String(importedImages.indexOf(source));
};
bindFileDrop($('dropZone'), (files) => {
  if (!busy) void importImages(files);
});
const exampleControl = createExampleSelector({
  examples,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const run = beginImport();
    const abort = () => {
      if (operation === run) cancel();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const files = await fetchFiles();
      assertCurrent();
      if (!await load(files[0], signal, run)) throw new Error('The example image could not be loaded.');
      assertCurrent();
    } catch (error) {
      run.fail(error);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      if (operation === run) setBusy(false);
    }
  },
  onStatus: status,
});
exampleControl.select.id = 'exampleSelect';
exampleControl.querySelector('label').htmlFor = 'exampleSelect';
$('exampleControl').replaceWith(exampleControl);

$('opacity').oninput = () => {
  const value = Number($('opacity').value);
  toolbar.control('overlayOpacityValue').textContent = `${Math.round(value * 100)}%`;
  if (output && viewer) viewer.setOpacity(1, value);
};
$('processButton').onclick = async () => {
  if (!source || busy || !webgpu) return;
  clearOutputs();
  const options = { fast: $('mode').value === 'fast', ct: $('ct').checked };
  const run = runs.begin('running', {
    inputs: { image: source },
    parameters: { mode: $('mode').value, ct: options.ct },
  });
  operation = run;
  setBusy(true, true);
  void show();
  $('progress').value = 0;
  started = performance.now();
  timer = setInterval(() => {
    $('elapsed').textContent = `${Math.round((performance.now() - started) / 1000)} s`;
  }, 1000);
  const fail = error => {
    if (!run.fail(error)) return;
    setBusy(false);
    status(error.message || String(error), true);
  };
  try {
    worker = new Worker(new URL('./inference-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = async ({ data }) => {
      if (!run.current) return;
      if (data.type === 'progress') {
        run.progress(data);
        status(data.message);
        $('progress').value = data.value;
      }
      if (data.type === 'error') fail(data.message);
      if (data.type === 'result') {
        try {
          const file = new File([data.buffer], `${outputStem(source.name)}_synthseg.nii.gz`, {
            type: 'application/gzip',
          });
          const image = await readNifti(data.buffer);
          if (!run.current) return;
          const measurements = summarizeLabels(image, freesurferLut);
          const succeeded = await run.succeed({
            artifacts: {
              labels: { file, type: 'neuro:label-map', mediaType: 'application/gzip', space: 'subject-1mm', labelSystem: 'FreeSurfer' },
            },
            provenance: data.provenance,
            measurements,
          });
          if (!succeeded) return;
          output = file;
          provenance = data.provenance;
          $('outputSection').open = true;
          $('progress').value = 1;
          setBusy(false);
          status(`Labels ready · ${provenance.outputShape.join(' × ')} · ${Math.round(provenance.seconds)} s`);
          void show();
        } catch (error) {
          if (operation !== run) return;
          if (runs.snapshot().state === 'failed') {
            setBusy(false);
            status(error.message, true);
          } else fail(error);
        }
      }
    };
    worker.onerror = event => fail(event.message || 'The inference worker could not run. Reload the app and try again.');
    const asset = manifest.assets.find((entry) => entry.filename === 'synthseg-2.0.onnx');
    worker.postMessage({
      file: source,
      options,
      model: { ...asset, url: `${assetBase}${asset.filename}?sha256=${asset.sha256}` },
    });
  } catch (error) {
    fail(error);
  }
};
function cancel() {
  exampleControl.cancel();
  if (!runs.cancel()) return;
  operation = null;
  ++viewRevision;
  clearOutputs();
  setBusy(false);
  $('progress').value = 0;
  status('Processing cancelled. Your original image is unchanged.');
}
$('cancelBtn').onclick = cancel;
$('saveBtn').onclick = () => output && !busy && downloadFile(output);
$('reportBtn').onclick = () => {
  const { report } = runs.snapshot();
  if (!report || busy) return;
  downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), report.artifacts.labels.filename.replace(/\.nii\.gz$/, '.json'));
};
$('privacyBtn').onclick = () => info.open('Privacy', $('privacyContent'));
$('standaloneBtn').onclick = () => info.open('Standalone', $('standaloneContent'), { wide: true });
if (!webgpu) {
  const message = 'This browser does not support WebGPU. SynthSeg needs WebGPU; try Chrome, Edge, or Safari 26 on a desktop.';
  runs.fail(message);
  status(message, true);
}
window.addEventListener('pagehide', () => {
  exampleControl.cancel();
  runs.cancel();
  worker?.terminate();
  clearInterval(timer);
});

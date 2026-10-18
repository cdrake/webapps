/**
 * deface — remove facial features from a brain MRI for anonymization, entirely
 * in the browser. No data leaves the machine.
 *
 * Pipeline: load a NIfTI (or DICOM folder via dcm2niix) → deface it with
 * `@neurodesk/deface`, the pipeline the `deface` command line runs: niimath
 * `-deface` (affine registration of a bundled MNI template + face mask, all BSD)
 * or MindGrab brain extraction → show + save the result. All niimath I/O is
 * uncompressed (`-gz 0`) for speed — NiiVue re-gzips on Save.
 */

import NiiVueGPU, {
  type ImageFromUrlOptions,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { mountImagingWorkspace } from '@neurodesk/webapp-components/core/mount-imaging-workspace'
import { bindFileDrop, createInfoDialog, createConsole, createExampleSelector } from '@neurodesk/webapp-components/ui'
import '@neurodesk/webapp-components/styles/imaging-workspace.css'
import { registerAppAutomation, registerViewer, createNiivueAdapter, runAbortable, type OperationContext } from '@neurodesk/webapp-components/automation'
import { readImageFiles, runDcm2niix, traverseDataTransferItems } from '@neurodesk/runtime-support/dcm2niix-client'
import { deface, TEMPLATE_NAMES } from '@neurodesk/deface'
import { createNiimathCommand, mindgrab } from '@neurodesk/deface/browser'
import { TEMPLATE_ASSETS } from '@neurodesk/deface/templates'
import examples from '../examples.json'

const templateUrl = (name: string): string => {
  const asset = TEMPLATE_ASSETS.find((item) => item.filename === name)
  if (!asset) throw new Error(`${name} is not pinned in @neurodesk/deface`)
  return asset.url
}
const MNI_URL = templateUrl(TEMPLATE_NAMES.template)
const MASK_URL = templateUrl(TEMPLATE_NAMES.mask)

mountImagingWorkspace({
  controls: '#controls',
  viewer: '#viewer',
  status: '#status',
  title: 'Deface',
  subtitle: 'Privacy-preserving MRI defacing in your browser',
  mark: 'D',
  controlsContract: { about: '#aboutBtn', privacy: '#privacyBtn' },
})

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

// --- DOM handles ---
const locationEl = $('location')
const loadingCircle = $('loadingCircle')
const statusMsg = $<HTMLLabelElement>('statusMsg')
const methodSelect = $<HTMLSelectElement>('methodSelect')
const applyBtn = $<HTMLButtonElement>('applyBtn')
const saveBtn = $<HTMLButtonElement>('saveBtn')
const aboutBtn = $<HTMLButtonElement>('aboutBtn')
const aboutDialog = createInfoDialog({ id: 'aboutDialog' })
const privacyDialog = createInfoDialog({ id: 'privacyDialog' })
const dicomPick = $<HTMLSelectElement>('dicomPick')
const niftiInput = $<HTMLInputElement>('niftiInput')
const dicomInput = $<HTMLInputElement>('dicomInput')
const methodDescription = $('methodDescription')
const technicalLog = createConsole({ id: 'technicalLog', outputId: 'consoleOutput', copyId: 'copyLogBtn', clearId: 'clearLogBtn' })
$('viewer').appendChild(technicalLog)

// --- NiiVue setup ---
// The NiiVue constructor is GPU-free; attachTo() takes WebGPU and falls back to
// WebGL2, and throws only when neither works. So construct here but defer
// attachTo to init(), which turns that failure into a status message instead of
// an unhandled top-level rejection.
const nv = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] })
type ExtCtx = ReturnType<typeof nv.createExtensionContext>
let ctx: ExtCtx | null = null

async function attachNiiVue(): Promise<void> {
  await nv.attachTo('gl1')
  registerViewer('main', createNiivueAdapter(nv))
  nv.multiplanarType = MULTIPLANAR_TYPE.GRID
  nv.sliceType = SLICE_TYPE.MULTIPLANAR
  nv.showRender = SHOW_RENDER.ALWAYS
  nv.crosshairGap = 5
  nv.isLegendVisible = false
  ctx = nv.createExtensionContext()
  ctx.on('locationChange', (e) => {
    locationEl.textContent = e.detail.string
  })
}

// --- App state ---
let isCleanedUp = false
let initializationFailure: Error | null = null
// The original loaded/dropped source image, fed to niimath. Apply always defaces
// THIS (not the previous defaced output), so repeated Apply clicks or switching
// methods re-run on the pristine source rather than degrading an already-cropped,
// already-defaced image.
let sourceFile: File | null = null
// Bundled MNI template + face mask, fetched once and reused for every run.
let refFiles: { template: Uint8Array; mask: Uint8Array } | null = null
// True once the CURRENTLY displayed volume is a defaced result. Save is gated on
// this so a user can't download the un-defaced source under the name defaced.nii.gz
// (a privacy footgun for an anonymization tool). Reset when a new source loads.
let hasDefaced = false

// niimath runs in one WebAssembly worker. MindGrab runs each segmentation in its own
// worker and loads its modules from the copies staged under mindgrab/ (vite.config.ts).
const niimath = createNiimathCommand()
const mindgrabAssets = new URL(`${import.meta.env.BASE_URL}mindgrab/`, window.location.href).href

const listeners = new AbortController()
const ac = { signal: listeners.signal }

// --- Status helpers ---
function setStatus(msg: string): void {
  statusMsg.textContent = msg
  // The footer cell ellipsizes; expose the full text (esp. long failures) on hover.
  statusMsg.title = msg
  statusMsg.classList.toggle('hidden', msg === '')
  if (msg) technicalLog.log(msg, msg.startsWith('Failed') ? 'error' : 'info')
}
function reportFailure(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  setStatus(`Failed: ${msg}`)
  console.error('deface task failed', err)
}
function spin(on: boolean): void {
  if (on) loadingCircle.removeAttribute('value')
  else loadingCircle.setAttribute('value', '0')
}

// --- Button gating ---
function updateButtons(): void {
  const busy = isBusy()
  applyBtn.disabled = busy || !sourceFile || !refFiles
  exampleControl.setDisabled(busy || !refFiles)
  methodSelect.disabled = busy
  saveBtn.disabled = busy || !hasDefaced
  aboutBtn.disabled = false
}

// --- Serial task queue (load / drop / deface must not overlap) ---
let pending: Promise<unknown> = Promise.resolve()
let inFlightCount = 0
function isBusy(): boolean {
  return inFlightCount > 0
}
function enqueue(fn: () => Promise<unknown>): void {
  if (isCleanedUp) return
  inFlightCount++
  updateButtons()
  pending = pending
    .then(fn)
    .catch(reportFailure)
    .finally(() => {
      inFlightCount--
      updateButtons()
    })
}

async function fetchBytes(url: string, name: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

// --- Load ---
// asSource=true for user-supplied images (default/drop/dcm2niix pick) — these
// become the pristine input that Apply defaces. The defaced result is displayed
// with asSource=false so it never replaces the source.
async function loadFromFile(file: File, asSource = true, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  // Fail closed: a source (asSource=true) is un-defaced, so clear Save eligibility
  // BEFORE the awaitable display — a load rejection after a prior deface must not
  // leave Save enabled over the un-defaced image (same pattern as makeBrainMask).
  if (asSource) {
    hasDefaced = false
    updateButtons()
  }
  try {
    await nv.loadVolumes([{ url: file, name: file.name } as ImageFromUrlOptions])
  } catch (err) {
    // A failed source load can leave the canvas blank/partial. Drop sourceFile so Apply
    // can't target a stale source that no longer matches the display (display/sourceFile
    // divergence). Rethrow so enqueue() still reports the failure.
    if (asSource) {
      sourceFile = null
      updateButtons()
    }
    throw err
  }
  if (isCleanedUp) return
  signal?.throwIfAborted()
  if (asSource) sourceFile = file
  // A freshly loaded source is NOT yet defaced; a deface result (asSource=false) is.
  hasDefaced = !asSource
  $<HTMLDetailsElement>('outputSection').open = hasDefaced
  updateButtons()
}

// --- Deface ---
const methodLabels: Record<string, string> = {
  allineate: 'allineate (fast)',
  allineate_robustfov: 'allineate (fast, robustfov)',
  allineate_hel: 'allineate (Hellinger)',
  allineate_hel_robustfov: 'allineate (Hellinger, robustfov)',
  mindgrab: 'mindgrab (tight)',
  mindgrab_robust: 'mindgrab (robustfov + tight)',
  mindgrab8: 'mindgrab (8 mm border)',
  mindgrab_robust8: 'mindgrab (robustfov + 8 mm border)',
}

async function runDeface(method = methodSelect.value, options: { signal?: AbortSignal; progress?: OperationContext['progress'] } = {}): Promise<File> {
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  if (!sourceFile || !refFiles) throw new Error('Load an image and the MNI reference before defacing.')
  const inputFile = sourceFile
  const templates = refFiles
  const report = (message: string) => {
    signal.throwIfAborted()
    if (isCleanedUp) throw new Error('The Deface workspace has closed.')
    setStatus(message)
    options.progress?.({ message })
  }
  const label = methodLabels[method] ?? method
  spin(true)
  // Hellinger is single-threaded in WASM (no OpenMP) and runs an exhaustive search, so it
  // is minutes on a full-head scan; set the expectation so a slow run doesn't look hung.
  report(`Defacing with ${label}… ${method.includes('_hel') ? 'single-threaded, up to a few minutes' : ''}`.trim())
  const t0 = performance.now()
  try {
    // Always deface the pristine source, so repeated Apply never re-defaces an
    // already-cropped or defaced output.
    const input = new Uint8Array(await inputFile.arrayBuffer())
    // Cancelling terminates the niimath worker and MindGrab's.
    const result = await runAbortable(
      signal,
      () => deface({ input, method, templates, niimath, mindgrab, mindgrabOptions: { assetPath: mindgrabAssets, signal }, onProgress: report }),
      () => niimath.dispose(),
    )
    const out = new File([result.image.bytes.slice().buffer], result.image.name)
    await loadFromFile(out, false, signal) // display result; keep sourceFile pristine
    report(`Defaced with ${label} (${Math.round(performance.now() - t0)} ms)`)
    return out
  } catch (err) {
    // A failed or out-of-memory run can leave the niimath heap corrupt; the next
    // Apply starts a fresh worker. Rethrow so enqueue() still reports "Failed: …".
    niimath.dispose()
    throw err
  } finally {
    spin(false)
    updateButtons()
  }
}

// --- Save ---
async function runSave(): Promise<void> {
  // Runtime guard, not just the disabled button: never serialize the un-defaced
  // source (privacy), and don't race an in-flight run. Surface failures via status
  // rather than dropping the promise at the listener (() => void runSave()).
  if (!hasDefaced || isBusy() || nv.volumes.length === 0) return
  try {
    await nv.saveVolume({ filename: 'defaced.nii.gz', volumeByIndex: 0 })
  } catch (err) {
    setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// --- DICOM / file drag-drop ---
let dcmConverted: File[] = []
const DIRECT_VOLUME_RE = /\.(nii|nii\.gz|mgh|mgz|nrrd|mha|mhd|nhdr|head|v)$/i

async function handleDrop(filesPromise: Promise<File[]>): Promise<void> {
  if (isCleanedUp) return
  spin(true)
  try {
    setStatus('Reading dropped files…')
    const files = await filesPromise
    if (files.length === 0) {
      setStatus('Drop contained no readable files.')
      return
    }
    // Fast-path a single obvious volume file straight to NiiVue.
    if (files.length === 1 && DIRECT_VOLUME_RE.test(files[0].name)) {
      dcmConverted = []
      dicomPick.classList.add('hidden')
      setStatus(`Loading ${files[0].name}…`)
      await loadFromFile(files[0])
      return
    }
    setStatus(`Converting ${files.length} file(s) with dcm2niix…`)
    const t0 = performance.now()
    const niftiFiles = await readImageFiles(files, { directVolume: DIRECT_VOLUME_RE })
    const ms = Math.round(performance.now() - t0)
    if (niftiFiles.length === 0) {
      setStatus('No NIfTI output produced. Are these DICOM images?')
      return
    }
    if (niftiFiles.length > 1) {
      dcmConverted = niftiFiles
      dicomPick.replaceChildren()
      niftiFiles.forEach((f, i) => {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.text = f.name
        dicomPick.appendChild(opt)
      })
      dicomPick.value = '0'
      dicomPick.classList.remove('hidden')
      setStatus(`dcm2niix: ${niftiFiles.length} NIfTI in ${ms} ms — pick one.`)
    } else {
      dcmConverted = []
      dicomPick.classList.add('hidden')
      setStatus(`dcm2niix: 1 NIfTI in ${ms} ms — loading…`)
    }
    await loadFromFile(niftiFiles[0])
  } finally {
    spin(false)
  }
}

// --- Init ---
async function init(): Promise<void> {
  // attachTo() falls back from WebGPU to WebGL2, so it fails only when the
  // browser offers neither, or its GPU is blocklisted for both.
  const noGraphics =
    'This browser can’t start the image viewer. It needs WebGL2 or WebGPU; use a recent Chrome, Edge, Firefox or Safari.'
  try {
    await attachNiiVue()
  } catch (err) {
    // Almost always missing graphics support; warn (not error, so the smoke's
    // console.error gate stays meaningful) so another init bug isn't silently
    // mislabeled. Either way return fail-closed: sourceFile/refFiles stay unset.
    initializationFailure = new Error(noGraphics, { cause: err })
    console.warn('deface: viewer init failed', err)
    document.querySelector('.nd-viewer-canvas-wrapper > [role="alert"]')?.remove()
    $('emptyState').hidden = false
    setStatus(noGraphics)
    return
  }
  setStatus('Loading MNI template…')
  // Fetch the bundled template/mask once; load the default subject.
  const [mni, mask] = await Promise.all([
    fetchBytes(MNI_URL, TEMPLATE_NAMES.template),
    fetchBytes(MASK_URL, TEMPLATE_NAMES.mask),
  ])
  refFiles = { template: mni, mask }
  setStatus('Drag and drop files')
}

const exampleControl = createExampleSelector({
  examples,
  onStatus: setStatus,
  onLoad: async (_example, { fetchFiles, signal, assertCurrent }) => {
    const [file] = await fetchFiles()
    assertCurrent()
    const job = pending.then(async () => {
      assertCurrent()
      inFlightCount++
      updateButtons()
      try { await loadFromFile(file, true, signal) }
      finally { inFlightCount--; updateButtons() }
    })
    pending = job.catch(() => {})
    await job
  },
})
$('exampleControl').append(exampleControl)
exampleControl.setDisabled(true)

// --- Wiring ---
document.addEventListener('dragover', (e) => e.preventDefault(), ac)
document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    const items = e.dataTransfer?.items
    if (!items || items.length === 0) return
    // A DataTransferItemList is only valid during this event; start traversal now.
    const filesPromise = traverseDataTransferItems(items)
    filesPromise.catch(() => {})
    enqueue(() => handleDrop(filesPromise))
  },
  ac,
)
dicomPick.addEventListener(
  'change',
  () => {
    const file = dcmConverted[Number(dicomPick.value)]
    if (file) enqueue(() => loadFromFile(file))
  },
  ac,
)
applyBtn.addEventListener('click', () => enqueue(() => runDeface()), ac)
saveBtn.addEventListener('click', () => void runSave(), ac)
aboutBtn.addEventListener('click', () => aboutDialog.open('Deface', $('aboutContent')), ac)
$<HTMLButtonElement>('privacyBtn').addEventListener('click', () => privacyDialog.open('Privacy', $('privacyContent')), ac)
niftiInput.addEventListener('change', () => {
  const files = Array.from(niftiInput.files ?? [])
  if (files.length > 0) enqueue(() => handleDrop(Promise.resolve(files)))
  niftiInput.value = ''
}, ac)
dicomInput.addEventListener('change', () => {
  const files = Array.from(dicomInput.files ?? [])
  if (files.length > 0) enqueue(() => handleDrop(Promise.resolve(files)))
  dicomInput.value = ''
}, ac)
bindFileDrop($('inputDropZone'), (files) => enqueue(() => handleDrop(files)))

const methodDescriptions: Record<string, string> = {
  allineate: 'Fast affine registration to remove facial voxels.',
  allineate_robustfov: 'Crops the neck, then fast affine registration. Use when the fit includes too much neck.',
  allineate_hel: 'Slower, exhaustive Hellinger registration for scans where the fast fit is not accurate.',
  allineate_hel_robustfov: 'Neck crop plus exhaustive Hellinger registration. The slowest affine option.',
  mindgrab: 'A neural network keeps the brain and removes everything outside it.',
  mindgrab_robust: 'Crops neck and lower slices before neural-network brain extraction.',
  mindgrab8: 'Neural-network brain extraction with an 8 mm border around the brain.',
  mindgrab_robust8: 'Neck crop, neural-network brain extraction, and an 8 mm brain border.',
}
methodSelect.addEventListener('change', () => {
  methodDescription.textContent = methodDescriptions[methodSelect.value] ?? ''
}, ac)

// --- Cleanup (HMR / tab close) ---
async function cleanup(): Promise<void> {
  // Every release step runs, so HMR never replaces a half-torn-down module; an
  // unexpected failure is rethrown only once teardown is complete.
  const failures: unknown[] = []
  const release = (step: () => void): void => {
    try {
      step()
    } catch (error) {
      failures.push(error)
    }
  }
  const finish = (): void => {
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Deface teardown failed')
  }
  release(() => exampleControl.destroy())
  if (isCleanedUp) return finish()
  isCleanedUp = true
  release(() => listeners.abort())
  // Terminate the niimath worker FIRST (don't await `pending`): an in-flight run is one
  // uninterruptible WASM call — a Hellinger fit would stall teardown for minutes. The
  // terminated run never resolves, so we deliberately drop the await; any run that already
  // resolved hits `if (isCleanedUp) return` before touching nv/ctx. MindGrab's worker
  // belongs to the run and ends with it.
  release(() => niimath.dispose())
  try {
    ctx?.dispose() // null if the viewer could not start (attachNiiVue failed)
  } catch {
    // best-effort — must not skip nv.destroy() below
  }
  release(() => nv.destroy())
  finish()
}
window.addEventListener('pagehide', (e) => {
  if (e.persisted) return
  cleanup().catch(reportFailure)
}, { once: true, signal: listeners.signal })
// Vite awaits the returned promise before it imports the updated module.
if (import.meta.hot) import.meta.hot.dispose(() => cleanup().catch(reportFailure))

registerAppAutomation({
  app: 'deface',
  convertDicom: runDcm2niix,
  operations: {
    async deface({ inputs, parameters, signal, progress }) {
      const files = inputs.image
      if (!Array.isArray(files) || files.length !== 1) throw new Error('Deface requires one selected image.')
      const method = parameters.method
      if (typeof method !== 'string') throw new Error('Choose a defacing method.')
      inFlightCount++
      updateButtons()
      const job = pending.then(async () => {
        signal.throwIfAborted()
        if (initializationFailure) throw initializationFailure
        if (!refFiles || !ctx) throw new Error('Deface could not initialize its viewer or MNI reference.')
        await loadFromFile(files[0], true, signal)
        const file = await runDeface(method, { signal, progress })
        signal.throwIfAborted()
        return { artifacts: [{ role: 'image', file }], provenance: { method, engine: method.startsWith('mindgrab') ? 'mindgrab-niimath' : 'niimath-wasm', reference: MNI_URL, faceMask: MASK_URL } }
      }).finally(() => { inFlightCount--; updateButtons() })
      pending = job.catch(() => {})
      return job
    },
  },
})

updateButtons()
enqueue(async () => {
  try { await init() }
  catch (error) {
    initializationFailure = error instanceof Error ? error : new Error(String(error))
    throw error
  }
})

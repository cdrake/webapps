# Catalog metadata audit

Audit of the landing-page metadata in `registry/apps.yml` (title, description,
categories, keywords) against what each app does, 2026-10-18. Facts come from
each app's `automation.json`, `examples.json`, README, `registry/app-information.yml`
and `registry/standalone.json`.

## How the catalog used the metadata

- A card showed the category of its section, an Experimental badge, the title,
  the description and the first 3 keywords as tags.
- Search matched the title, description, category titles and all keywords.
- `description` is also the app bar subtitle in every app (`site/app-shell.js`),
  part of the Cite reference, and the About text when an app has no About
  paragraphs. It must stay one short sentence.

## Findings

### Tags

- Only the first 3 keywords were visible. On 15 cards one of them was `MRI`.
- Several first-3 sets repeated the title or named tools, not tasks:
  SYNcro `SYNcro, SynthSR, MindGrab`, SynthSeg `SynthSeg, MRI, CT`,
  TopoFit `TopoFit, cortical surface, MRI`.
- Case was inconsistent: Brain2Print had `mri` and `3d-printing`.
- No card told a visitor what they most often need to choose an app: the input
  format, the anatomy, whether the app needs WebGPU, and whether a command line
  exists.

### Descriptions

- Style was inconsistent: "Browser-based", "Browser-native", "in the browser",
  "locally in your browser", "entirely in the browser". The site header already
  says every tool runs locally, so the phrase used words without information.
- Length went from 5 words (Greedy, EdgeReg) to 35 words (NeSVoR).
- CALMaR only expanded its acronym; it did not say that it maps stroke lesions.
- Several descriptions named the method but not the task (SynthSR, QSMbly) or
  the task but not the input (Carotid Flow, Disconnectome).

### Categories

- Normalization had 1 app and Surfaces 2.
- Brain2Print and TopoFit were under Visualization; they reconstruct meshes and
  surfaces.
- LCModel (spectroscopy) was under Quantitative Imaging.
- Disconnectome and CALMaR (lesion-to-network mapping) were under
  Segmentation & Analysis with muscle, vessel and prostate segmentation.
- SynthSR and NeSVoR (image synthesis and reconstruction) were under Data
  Preparation & Privacy with defacing.

### Titles (not changed in this pass)

Titles reach each app's `index.html`, `automation.json` and shell code, so
changing them is per-app work. Proposals:

| App | Current | Proposed | Reason |
| --- | --- | --- | --- |
| brain-extraction | Brain extraction | Brain Extraction | Title Case like the other 29 titles |
| white-matter-lesions | White matter lesions | White Matter Lesions | Same |
| easy-mp2rage | Easy MP2RAGE T1 Map | Easy MP2RAGE | The app also makes B1 maps and denoised UNI images |
| dicom2vid | MRI2VID | keep, or rename id | The id and the title differ; the app also accepts CT |

Lower-case upstream names (dicompare, dwi2trx, elastix) stay as their projects
write them.

### Source discrepancies found during the audit

These are findings for the maintainers; this pass does not fix them.

1. **WebGPU gates that NiiVue does not need.** Every pinned NiiVue 1.0 rc
   (rc.9 to rc.16) falls back to WebGL2 when `navigator.gpu` is absent
   (`enforceBackendAvailability`, `attachTo` tries `webgpu` then `webgl2`).
   But deface (`src/main.ts:509`), BrowserQC (`src/main.ts:460`), EdgeReg
   (`src/main.js:348`), Greedy (`src/main.js:370`), ANTs (`src/main.js:379`)
   and Brain2Print (`src/main.js:274`) refuse to start without WebGPU. The
   comment in deface and BrowserQC says "NiiVue's attachTo() acquires a WebGPU
   device and throws without one", which the pinned builds contradict. EdgeReg,
   Greedy and ANTs compute on WASM. Removing these gates would let these apps
   run in browsers without WebGPU; the catalog marks them "Needs WebGPU" until
   then.
2. **Command line without a download.** MuscleMap, VesselBoost, SeedSeg, CALMaR
   and NiiMath have a `packages/<x>/bin` command line and READMEs that describe
   portable releases, but `registry/standalone.json` lists no `cli` download.
   The catalog takes the CLI badge from `standalone.json`, so these five show no
   badge until it lists their downloads.
3. **CALMaR "Reporting".** The title promises reporting; the app downloads CSV
   and NIfTI only, with no report document.
4. **SynthSR input formats.** The README says NIfTI only; `automation.json` and
   the app accept DICOM through dcm2niix.
5. **FireANTs without WebGPU.** The README says CPU registration and viewing
   work without WebGPU; the NiiVue fallback above makes this true, but it has no
   test.
6. **Spinal Cord Toolbox task count.** The model manifest lists 21 tasks; 5 run
   in the browser.
7. **NeSVoR default mode.** The README leads with the remote GPU server; the
   app defaults to experimental browser WebGPU.
8. **SeedSeg** is the only app without a built-in example (`examples.json` is
   empty), against the example contract in the interface standard.
9. **Stale description copies.** `apps/easy-mp2rage/package.json`,
   `apps/zarro/package.json`, `apps/surfannotate/index.html` (meta) and
   `apps/calmar/web/index.html:506` hold old copies of the catalog description.

## Proposal

### Description rule

One sentence, at most 100 characters, task first and method second, plain words
for a mixed audience of researchers, clinicians and students. Name the input
(contrast or format) when it limits use. Do not say "in the browser" or
"locally": the page says it once for every app.

### Categories

Ten categories, each with at least two apps. Ids changed only where the meaning
changed.

| Id | Title | Apps (secondary in italics) |
| --- | --- | --- |
| segmentation | Segmentation | MuscleMap, VesselBoost, Spinal Cord Toolbox, SeedSeg, SynthSeg, White Matter Lesions, Brain Extraction |
| lesion-mapping | Lesion Mapping | CALMaR, Disconnectome, *SYNcro*, *White Matter Lesions* |
| quantitative-mri | Quantitative MRI & Spectroscopy | QSMbly, Easy MP2RAGE, Carotid Flow, LCModel |
| diffusion-imaging | Diffusion & Tractography | dwi2trx, *Disconnectome* |
| registration | Registration & Normalization | SYNcro, EdgeReg, Greedy, ANTs, FireANTs, elastix |
| reconstruction | Reconstruction & Synthesis | SynthSR, NeSVoR |
| surfaces | Surfaces & Meshes | TopoFit, SurfAnnotate, Brain2Print |
| image-processing | Processing & Privacy | NiiMath, Deface, *Brain Extraction* |
| visualization | Visualization | ZARRo, MRI2VID, *SurfAnnotate* |
| quality-control | Quality Control | BrowserQC, dicompare |

### Facets

Typed fields in `registry/apps.yml`, validated in `scripts/lib/apps-registry.mjs`
and shown as card badges and search terms:

| Field | Values | Badge |
| --- | --- | --- |
| `anatomy` | brain, spinal-cord, whole-body, prostate, neck, any | "Brain", "Spinal cord", … |
| `modalities` | mri, ct, mrs, microscopy, surface | "MRI", "CT", "MRS", … |
| `inputs` | dicom, nifti, mgz, ome-zarr, tiff, itk, gifti, freesurfer, mesh, mrs-raw | "DICOM", "NIfTI", … |
| `hardware` | cpu, webgpu-optional, webgpu-required | "No GPU needed", "WebGPU optional", "Needs WebGPU" |
| `remote_compute` | true (optional) | "Compute server option" (Spinal Cord Toolbox, NeSVoR) |

Two badges come from existing files, not from new fields, so they cannot drift:

- **CLI**: `registry/standalone.json` lists a `cli` download.
- **Example data** was considered and dropped: 30 of 31 apps have one, so the
  badge would not help a visitor choose.

`hardware` records what a visitor gets today, including the gates in finding 1.

Keywords stay, for search only: they are no longer shown, so their order no
longer matters. They now carry plain-language synonyms (skull stripping, stroke,
fetal, 3D printing) and no longer repeat the title.

### Per-app result

| App | Proposed description | Anatomy | Modality | Inputs | Hardware | CLI |
| --- | --- | --- | --- | --- | --- | --- |
| MuscleMap | Segment muscles in body MRI or CT and measure muscle volume and fat. | whole-body | MRI, CT | DICOM, NIfTI | WebGPU optional | – (finding 2) |
| VesselBoost | Segment brain blood vessels in TOF angiography or SWI images. | brain | MRI | DICOM, NIfTI | WebGPU optional | – (finding 2) |
| Spinal Cord Toolbox | Segment the spinal cord, gray matter, lesions and vertebrae, and measure the cord. | spinal-cord | MRI, CT | DICOM, NIfTI | WebGPU optional, remote | – |
| CALMaR | Map a stroke lesion to MNI space and find the brain regions and networks it affects. | brain | MRI | DICOM, NIfTI | WebGPU optional | – (finding 2) |
| QSMbly | Make susceptibility (QSM), R2* and SWI maps from multi-echo MRI phase and magnitude. | brain | MRI | DICOM, NIfTI | CPU | – |
| SeedSeg | Find gold fiducial markers in prostate MRI for radiotherapy planning. | prostate | MRI | DICOM, NIfTI | CPU | – (finding 2) |
| dicompare | Check DICOM acquisitions against a reference protocol and build protocol schemas. | any | MRI | DICOM | CPU | – |
| Deface | Remove facial features from head MRI so that scans can be shared. | brain | MRI | DICOM, NIfTI | Needs WebGPU | – |
| Easy MP2RAGE T1 Map | Make B1-corrected T1 maps and denoised UNI images from MP2RAGE scans. | brain | MRI | DICOM, NIfTI | CPU | yes |
| NiiMath | Apply image maths, filters, thresholds and meshing with niimath commands. | any | MRI, CT | DICOM, NIfTI | CPU | – (finding 2) |
| MRI2VID | Turn a DICOM, NIfTI or MGZ volume into a scrolling slice video. | any | MRI, CT | DICOM, NIfTI, MGZ | CPU | – |
| BrowserQC | Measure MRIQC-style image-quality metrics on T1-weighted brain MRI. | brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| SurfAnnotate | View cortical surfaces with overlays and draw regions of interest on them. | brain | surface | GIfTI, FreeSurfer, mesh | CPU | – |
| ZARRo | Stream, view and measure large multiscale OME-Zarr images, such as microscopy. | any | microscopy | OME-Zarr | CPU | – |
| SynthSR | Make a 1 mm T1-weighted brain image from an MRI scan of any contrast or a CT scan. | brain | MRI, CT | DICOM, NIfTI | WebGPU optional | yes |
| SynthSeg | Label brain structures in MRI or CT of any contrast and compare volumes with norms. | brain | MRI, CT | DICOM, NIfTI | Needs WebGPU | yes |
| SYNcro | Normalize brain scans and lesion masks of any contrast, or CT, to MNI space. | brain | MRI, CT | DICOM, NIfTI | WebGPU optional | yes |
| dwi2trx | Fit diffusion tensors (FA, MD) and track white-matter streamlines from diffusion MRI. | brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| EdgeReg | Align two brain images with fast affine registration using niimath. | brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| Disconnectome | Find which white-matter bundles a lesion in MNI space disconnects. | brain | MRI | DICOM, NIfTI | CPU | yes |
| Greedy | Align brain images with affine and deformable registration using Greedy. | brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| ANTs | Align brain images with affine and SyN deformable registration using ANTs. | brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| Brain2Print | Make a 3D-printable brain model (STL or OBJ) from a brain MRI. | brain | MRI | DICOM, NIfTI | Needs WebGPU | yes |
| TopoFit | Reconstruct white and pial cortical surfaces from a T1-weighted brain MRI. | brain | MRI | DICOM, NIfTI | CPU | yes |
| FireANTs | Align brain images with affine and deformable registration using FireANTs. | brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Brain extraction | Remove the skull and make a brain mask with BET, MindGrab or SynthStrip. | brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| Carotid Flow | Measure carotid blood flow curves from a phase-contrast MRI slice of the neck. | neck | MRI | DICOM, NIfTI | CPU | yes |
| LCModel | Process single-voxel MR spectroscopy and measure metabolite concentrations. | brain | MRS | DICOM, NIfTI, vendor MRS | CPU | yes |
| White matter lesions | Segment white matter lesions on FLAIR MRI, as in multiple sclerosis. | brain | MRI | DICOM, NIfTI | WebGPU optional | yes |
| NeSVoR | Reconstruct a 3D fetal or neonatal brain volume from motion-corrupted 2D MRI stacks. | brain | MRI | DICOM, NIfTI | WebGPU optional, remote | – |
| elastix | Align MRI, microscopy and other images with rigid, affine or B-spline registration. | any | MRI, CT, microscopy | DICOM, NIfTI, OME-Zarr, TIFF, ITK formats | CPU | – |

## Follow-up

- 27 of 31 cards read "DICOM, NIfTI". If that row reads as noise on the live
  site, show only formats beyond that pair and say once, above the catalog,
  that apps accept DICOM and NIfTI unless a card says otherwise.

- Filter chips for the hardware and CLI facets, once the badges have been
  reviewed on the live site.
- Per-app `<meta name="description">` and JSON-LD `SoftwareApplication` entries
  generated from the same fields.
- Findings 1–9 above.

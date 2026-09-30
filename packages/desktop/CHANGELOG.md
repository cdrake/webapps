# @neurodesk/desktop

## 0.15.20260921

### Minor Changes

- 94f7cac: Add the NeSVoR fetal slice-to-volume reconstruction app and the decoupled compute feature it needs. The app prepares stacks, thicknesses and protocol presets in the browser and sends the job to a `neurodesk-compute` server in the user's own network (`exes/compute-server`, Rust), which runs the pinned Neurodesk `nesvor` 0.5.0 container and streams progress back. The components package gains the remote compute client (`@neurodesk/webapp-components/compute`) and the `nd-compute-connection` sidebar panel; the desktop suite admits the origins listed in `NEURODESK_COMPUTE_ORIGINS`. The shared About statement is split into `builder` and a per-app overridable `execution` sentence.

  Fix paired job ownership, durable recovery and retention, content-checked idempotency, and cancellation that waits for runner termination. Keep credentials out of local storage, recover jobs after tab reload, import DICOM locally, and preserve examination identity during uploads, viewing and processing. Package the Linux backend with the production frontend and add a real CUDA validation command.

  Add an explicitly experimental browser CPU reference for small prealigned masked stacks, with per-case differentiable NeSVoR fitting, NIfTI output, provenance and worker cancellation. This is not the complete browser port: full SVoRT, WebGPU training, upstream numerical parity, and clinical-sized validation remain pending. Simulator tests do not establish scientific correctness.

## 0.14.20260918

### Patch Changes

- Include MuscleMap's clearer input image type, preview, and segmentation controls alongside the current app releases.

## 0.13.20260918

### Patch Changes

- Include the original TOF-MRA example for VesselBoost alongside the corrected Calmar example.

## 0.12.20260918

### Patch Changes

- Use suite 0.12 for Calmar; concurrent SeedSeg, MuscleMap and VesselBoost publishers already selected 0.10 and 0.11.

## 0.11.20260918

### Patch Changes

- Reserve a distinct offline suite version for Calmar's corrected example while the SeedSeg suite release is in progress.

## 0.10.20260918

### Patch Changes

- Remove SeedSeg's unsuitable synthetic example from the offline suite.

## 0.9.20260918

### Minor Changes

- b5143b7: Replace the two suite editions with one platform archive plus one platform-independent model pack.

  The models-included edition embedded the same ~2.0 GB of model files in all four platform archives, which uploaded about 6 GB of identical bytes per release. The models now ship once as `webapps-VERSION-models.tar.gz`, whose entries are the sha256-named files the application already keeps in its model cache.

  `createModelResolver` takes an optional pack directory and checks it before the cache and before any network fetch. A matching file is served where it is, so the pack can be read-only and shared. Set `NEURODESK_MODELS_DIR` to the absolute path of the extracted pack for a fully offline install, or bind-mount one shared pack into every HPC job.

  The published catalog `suite` now carries four platform downloads plus a `models` record, and the per-download `modelsIncluded` edition flag is gone.

### Patch Changes

- 28baa44: Build the model pack from fixed archive headers so one model set always produces one archive, and reference an already published archive in a new suite instead of uploading its bytes again.

## 0.8.20260917

### Patch Changes

- Publish an offline suite containing TopoFit 0.7.20260917.

## 0.7.20260917

## 0.7.20260916

## 0.6.20260916

## 0.6.20260915

### Patch Changes

- Prevent Niimath input loading from overwriting processed results during offline batch jobs.

## 0.5.20260915

### Patch Changes

- Include T1 and T2 head MRI examples for Brain extraction.

## 0.4.20260915

### Minor Changes

- Add Brain extraction with BET, MindGrab and SynthStrip, including the pinned model and an offline extraction check.

## 0.3.20260915

### Patch Changes

- Add OpenRecon scanner-console package links for MuscleMap, QSMbly via QSMxT, Spinal Cord Toolbox, SynthSeg, TopoFit and VesselBoost.

## 0.2.20260915

### Minor Changes

- Offer desktop and HPC downloads both with and without models. Put official Neurodesk Docker and Apptainer downloads first, simplify installation details, and separate standalone choices into clear sections.

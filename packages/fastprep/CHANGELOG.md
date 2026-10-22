# @neurodesk/fastprep

## 0.1.20261018

### Patch Changes

- c93ed0b: Denoise runs with three or more echoes with ME-ICA (meica, a Rust port of tedana): components are classified on the motion- and distortion-corrected echoes and the rejected ones regressed from each preprocessed series (`desc-denoised`). The report adds a Multi-echo ICA section and runs the task GLM on both series. Adds a pinned multi-echo example.

  Reject undeclared ME-ICA browser options, extra scalar values and missing option values.

## 0.1.20261017

### Patch Changes

- 1c11f1c: New app: fastprep, fMRI preprocessing of one BIDS subject in the browser (Rust/WASM port of fastprep.py with greedy, niimath, MindGrab, SynthSR and glm), with an HTML report and zipped derivatives. Drop a BIDS folder anywhere on the page, or choose one from the input menu.

  Reject invalid BOLD repetition times and nonfinite confounds, escape report metadata, rerun the GLM when its BOLD sidecar changes, and restore example inputs through page-drop Undo.

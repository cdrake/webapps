# @neurodesk/n4

## 0.6.20261024

### Minor Changes

- Add the niworkflows EPI-reference N4 argv builder and allow the existing runtime to select it without changing the default MRtrix profile or WASM bytes. This is independent entry-point wiring; the full SyN-SDC accuracy and memory gates remain pending.

## 0.5.20261024

### Patch Changes

- 00005df: `scripts/build.sh --check` rebuilds the N4 WebAssembly module and fails unless `n4-bias.wasm` and `n4-bias.mjs` equal the committed files. The build sets `SOURCE_DATE_EPOCH`, so ANTs' compiled-in build date no longer changes the bytes, and the weekly `n4-wasm-source` workflow runs the check. The committed module is unchanged.

## 0.4.20261024

### Patch Changes

- Restore the WebAssembly stack after each kernel call so repeated corrections and transform applications do not exhaust the stack. Export the stack functions from the pinned builds and verify 200 runs on one instance.

## 0.4.20261022

## 0.3.20261022

## 0.3.20261020

## 0.3.20261019

## 0.2.20261018

### Minor Changes

- 80bd5e9: N4 is a new app that corrects the bias field of MRI in the browser with ANTs N4BiasFieldCorrection. Load a 3D image, or a DWI with its bval and bvec, or a DICOM series, and choose Correct bias field. For a DWI it follows MRtrix `dwibiascorrect ants`: N4 on the mean b0 weighted by the brain mask, the field rescaled to keep the brain's total signal, and every volume divided by it. A 3D image is corrected directly. The mask is one you supply, or an Otsu threshold of the mean b0. N4 runs in a worker with a cancel. The corrected image, the bias field and the mask download with BIDS derivative names, and a bval, bvec and sidecar pass through under the new name.

  `@neurodesk/n4` is ANTs N4BiasFieldCorrection compiled to WebAssembly, separate from `@neurodesk/registration` at the same ANTs commit and ITK-Wasm toolchain. Its bias field on the ds005134 example slab equals native ANTs 2.6.5 exactly.

---
"deface": minor
"@neurodesk/deface": minor
"@neurodesk/runtime-support": minor
"@neurodesk/brain2print": patch
---

Add the `deface` command line. The defacing pipeline moves out of the web app into `@neurodesk/deface`, which the app and the command line share: niimath's affine `-deface` (fast or Hellinger, with or without robustfov) and MindGrab brain extraction (tight or with an 8 mm border). The command line runs the app's frozen BSD-2 niimath WebAssembly through `@neurodesk/node-drivers/niimath` and MindGrab's threaded CPU module through `@neurodesk/node-drivers/mindgrab`, writes the app's `defaced.nii` (and `brain-mask.nii` for MindGrab), and installs the MNI template and face mask with SHA-256 checks. It ships as portable Linux x64 and Windows x64 archives and a signed macOS arm64 installer. Each release must reproduce the app's pipeline as recorded in Chromium on the app's example: niimath output identical byte for byte and a MindGrab mask Dice of 0.99 or better.

The web app now runs MindGrab from `@brainchop/mindgrab` 0.1.20260925 instead of its own WebGPU copy of the model. The weights are byte-identical; the package adds its own conform, normalisation and largest-component cleanup, and runs on a hardware GPU or, without one, the threaded CPU module, so MindGrab no longer needs `shader-f16`. The app stops downloading `net_mindgrab.safetensors`. `@neurodesk/runtime-support` gains `niimath/command`, which runs a niimath argv in the vendored worker, and `mindgrab`, the browser MindGrab runtime that Brain2Print used, which now lives there for both apps.

---
"n4": minor
"@neurodesk/n4": minor
---

Add a portable `n4` command line for Linux, Windows and macOS. It runs the app's ANTs N4 WebAssembly module with the `dwibiascorrect ants` options (`-s 4 -b [100,3] -c [1000,0.0]`): it corrects a 3D image directly, and for a DWI it fits the field to the mean b0, rescales it and divides every volume by it. The fit is weighted by a MindGrab brain mask of the mean b0 (or the image) on the CPU, through `@neurodesk/node-drivers/mindgrab`; `--mask FILE` gives another mask. It writes the app's downloads: the corrected image, the bias field, the brain mask, and the passed-through bval, bvec and sidecar. It pairs `<stem>.bval`/`.bvals`, `<stem>.bvec`/`.bvecs` and `<stem>.json` beside the image, and for a series FSL's `bvals` and `bvecs`; a sidecar named with `--json` must hold a JSON object. The mean b0, output names and sidecar now live in `@neurodesk/n4/pipeline`, shared by the app and the command line. Its release check runs the three pinned examples and holds every output to the web app's recorded download: each image by its decompressed bytes, the other files byte for byte.

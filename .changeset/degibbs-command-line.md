---
"degibbs": minor
"@neurodesk/degibbs": minor
---

Add a portable `degibbs` command line for Linux, Windows and macOS. It runs the app's `degibbs.wasm` with the `mrdegibbs` options (`--nshifts`, `--min-w`, `--max-w`) and slice axes from the sidecar's `SliceEncodingDirection` (or `--axes`), and writes the app's downloads: the corrected image, the passed-through bval and bvec, and the sidecar. The output names and sidecar now live in `@neurodesk/degibbs/outputs`, shared by the app and the command line. Its release check runs the pinned example and holds every output to the web app's recorded download: the image by its decompressed bytes, the other files byte for byte. `@neurodesk/degibbs` now shares the app's version.

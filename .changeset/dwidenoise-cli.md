---
"dwidenoise": minor
"@neurodesk/dwidenoise": minor
---

Add the `dwidenoise` command line. It runs the web app's Patch2Self (the same `dwidenoise.wasm`, DIPY 1.12.1 version 1 port) on a NIfTI series and writes the app's four downloads. The worker pool (the three passes with one solve per volume), the worker handler, the gzip worker and the output names move to `@neurodesk/dwidenoise` (`./pool`, `./worker`, `./gzip`, `./pipeline`), so the app's Web Workers and the command line's worker threads run the same messages, and the output is the same for any number of threads. Like the app, the command line writes the result straight into the output NIfTI and takes `cal_max` from the workers, and it reads the .bval with the shared `parseBval`. Its release check holds every output to the downloads that the production app records.

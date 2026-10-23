---
"@neurodesk/webapp-components": minor
---

Add `bidsDiffusionSeries`, `chosenBidsRun` and `chooseBidsRun` to `file-io/bids`. `bidsDiffusionSeries` gives each DWI run of a dropped BIDS folder as a diffusion series (image, bval, bvec and the merged JSON sidecar), in the shape of `readDiffusionSeries`. The `require` option names the gradient tables that the app needs; a run without one of them lists it in `missing`. It returns null for loose files, so an app reads them as before. `chooseBidsRun` remembers the loaded run, so the same files (for example on Undo) load that run again. `readBidsDiffusion` now orders runs by number, so run-2 comes before run-10.

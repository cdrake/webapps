---
"@neurodesk/webapp-components": minor
"@neurodesk/dwidenoise": minor
"dwidenoise": patch
---

Dwidenoise solves each Patch2Self volume in a worker. The page no longer runs a group solve, the NIfTI writer or gzip on its own thread, so it stays responsive and the footer × stops a run between two volumes. The status bar shows the Gram, solve and prediction passes, weighted by their cost. The workers write the result straight into the output NIfTI and find its `cal_max`, and a worker compresses the file without a copy. On the full-brain ds005134 DWI (509 MB as Float32), the renderer's peak memory went from 3475 MB to 3011 MB and the longest main-thread task from 9.0 s to 0.17 s. The output is the same, bit for bit, on the e2e fixtures, the slab and the full brain. Dwidenoise also refuses a DWI above the shared 2 GB input limit before decoding it.

`@neurodesk/dwidenoise` adds `solveVolume` (one row of `solve`, from the new `solve_volume` WebAssembly export), `denoiseChunks` (the app's worker schedule in one thread) and `CHUNK_VOXELS`. `scripts/check-slab.mjs --app OUTPUT.nii.gz` requires app outputs to equal `denoiseChunks` bit for bit.

`@neurodesk/webapp-components/file-io` adds `allocateNifti`, the file `createNiftiFromData` writes with a typed view of its voxels to fill in place, so a page that writes a large image holds one copy of it.

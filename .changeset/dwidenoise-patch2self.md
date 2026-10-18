---
"@neurodesk/dwidenoise": minor
---

`@neurodesk/dwidenoise` holds the WebAssembly port of DIPY 1.12.1 Patch2Self version 1 (patch radius 0, ordinary least squares; BSD-3-Clause), built from `exes/dwi/denoise`. Each volume is predicted from the other volumes of its group (b0 or diffusion-weighted) by one regression over all voxels. The data stays in module memory and is denoised in place, and voxel ranges can be split across workers. On the ds005134 slab its output equals DIPY's (with the regressors not centred in place) bit for bit in float32.

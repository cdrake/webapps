---
"dwidenoise": minor
"@neurodesk/dwidenoise": minor
---

Dwidenoise is a new app that denoises diffusion MRI in the browser with Patch2Self (Fadnavis et al. 2020). Load a 4D NIfTI with its bval (and optionally its bvec and sidecar) or a DICOM diffusion series and choose Denoise. Each volume is predicted from the other volumes of its group, b0 (b below 50 s/mm²) or diffusion-weighted, by one regression over all voxels; a single b0 is kept unchanged, and a series with fewer than 2 diffusion-weighted volumes is refused with a clear status. Up to 4 Web Workers add the Gram sums of voxel chunks, the main thread solves each group once, and the workers apply the fit, with progress and a cancel in the status bar. The image downloads as `<stem>_desc-denoised_<suffix>.nii.gz` (float32), with the bval, bvec and sidecar under the same name, so degibbs can read them next.

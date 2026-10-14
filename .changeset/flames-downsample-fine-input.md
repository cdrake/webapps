---
"white-matter-lesions": patch
"@neurodesk/white-matter-lesions": patch
"@neurodesk/synthsr": patch
---

FLAMeS no longer rejects high-resolution FLAIR. A 0.4 mm 3D FLAIR of
544 × 544 × 480 voxels exceeded SynthSR's 128 Mi voxel reader cap and failed
with "Unsupported image dimensions". An input finer than FLAMeS's
1 × 0.9 × 0.9 mm grid is now downsampled to that grid with nnU-Net's cubic
resampling before brain extraction. Inputs up to 512 Mi voxels are accepted.
The mask, probability map and table then use the resampled grid; the web app
shows them over the resampled FLAIR and offers it for download, and the
`flames` command writes it as `INPUT_flair_resampled.nii`. Inputs at or
coarser than 1 × 0.9 × 0.9 mm are unchanged. `readVolume` in
`@neurodesk/synthsr` takes an optional `maxVoxels` cap.

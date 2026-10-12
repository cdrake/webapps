---
"lcmodel": patch
"@neurodesk/lcmodel": patch
---

Tissue correction now works for GE P-files and for high-resolution T1 images.

- GE P-files record the voxel: its centre and size (`user8-13`) and the
  prescription plane (`tlhc`, `trhc`, `brhc`) in the image header. The reader
  now builds the voxel affine from them as spec2nii does, so a GE dataset can
  be segmented and measured on its T1 instead of reporting that the format
  does not record where the voxel is.
- MindMap's WebGPU and WebGL2 modules have a fixed 768 MiB heap and ran out of
  memory on T1s larger than its 256³ grid (0.8 mm isotropic, GE's 512 x 512
  BRAVO), which surfaced as "the mindmap module exited cleanly but wrote no
  output". Those T1s now segment on the threaded CPU module, and a failed GPU
  run is retried there.
- Philips spectra converted to NIfTI-MRS by spec2nii keep their `_act` and
  `_ref` names; the water reference now pairs with its spectrum in every
  format, not only SDAT/SPAR, so these datasets are water-scaled and can be
  tissue-corrected.

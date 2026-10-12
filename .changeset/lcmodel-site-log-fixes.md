---
"lcmodel": patch
"@neurodesk/lcmodel": patch
---

Fix three failures reported from multi-site data:

- Water references pair with `<stem>_act` and `<stem>_ws` spectra in every format, not only SDAT/SPAR, so spec2nii's conversions of Philips data (`_act`/`_ref`) are water-scaled. `_water_off` and `_nows` name a water reference. A leftover water reference pairs with its folder's single spectrum (a Siemens session's numbered series), and DICOM series without spectroscopy data are skipped instead of counted as datasets.
- NIfTI-MRS converted from GE data (`Manufacturer` GE) is phased on the residual water as GE P-files are (`run_pressproc_GEauto`), instead of being left about 60 degrees out of phase.
- When MindMap fails on the GPU, the technical log shows the module's own output and the voxel is segmented on the CPU instead.

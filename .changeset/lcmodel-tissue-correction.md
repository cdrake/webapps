---
"lcmodel": minor
---

Add tissue-corrected concentrations. The readers now take the voxel's position, size and orientation from Siemens twix, DICOM and RDA, Philips SPAR and NIfTI-MRS headers (spec2nii's conventions). An optional T1 from the same session is segmented in the browser with MindMap's partial-volume maps, the voxel is drawn on it in a new Voxel view, and its grey matter, white matter and CSF fractions, or fractions typed in from another tool, correct the water-scaled concentrations as in Gasparovic et al. 2006 with Osprey's constants (alpha-corrected GABA and Glx for edited data). The table gains a tissue-corrected column; downloads add the corrected CSV, the inputs as JSON, the voxel mask and the tissue maps. A new example pairs Osprey's Philips PRESS data with its defaced T1.

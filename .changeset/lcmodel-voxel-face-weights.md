---
"@neurodesk/lcmodel": patch
"lcmodel": patch
---

The spectroscopy voxel's T1 weights sample each T1 voxel on a 6 x 6 x 6 sub-grid instead of 5 x 5 x 5. With five samples the middle sub-point lay on any box face that passes through a voxel centre, and those face layers got 3/5 of their weight instead of 1/2: a 20 mm box on a 1 mm T1 measured 3 % too large, and its outer layers counted more than they should in the tissue fractions. Boxes whose faces fall on voxel centres now measure their exact volume. On the Philips PRESS example, which is oblique, the GM, WM and CSF fractions and the corrected concentrations are unchanged; the voxel mask and the reported `voxelInT1Mm3` (27004.2 mm³ for the 27000 mm³ box) change slightly.

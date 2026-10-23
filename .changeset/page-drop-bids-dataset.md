---
"@neurodesk/webapp-components": patch
---

A BIDS diffusion dataset (a folder with a `sub-*/[ses-*/]dwi/*_dwi.nii[.gz]` image) dropped on the page now stays together at the primary input. Before, its DWI runs filled the empty image slots, so a second run went to an app's mask input. Other drops, BIDS anatomical pairs included, fill the image slots as before.

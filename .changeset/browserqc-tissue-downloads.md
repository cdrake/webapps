---
"browserqc": minor
"@neurodesk/browserqc": patch
---

BrowserQC offers the brain mask and the GM, WM and CSF fraction maps (or the label map) as downloads under Image quality. The file names start with the input name. About tells that the CSF map covers the ventricles only and that the three maps are separate fractions. The package README gives the correct data type of the fraction maps: uint8 with `scl_slope`, not float32.

---
"@neurodesk/noddi": minor
"@neurodesk/dwi2trx": patch
"noddi": patch
---

Keep tensor backend selection in NODDI's shared fitting pipeline. The command line accepts
`--tensor-fit niimath-dtifit` and uses the same corrected vendored runtime, volume selection,
map conversion and optional NODDI fit as the browser. Weighted least squares remains the default.

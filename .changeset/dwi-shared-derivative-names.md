---
"@neurodesk/webapp-components": minor
"@neurodesk/degibbs": patch
"@neurodesk/hmc": patch
"@neurodesk/noddi": patch
"degibbs": patch
"dwidenoise": patch
"n4": patch
"noddi": patch
---

Add `@neurodesk/webapp-components/file-io/bids-derivatives`: one module for the BIDS-derivative names (`splitName`, `sourceStem`, `outputNames(fileName, desc)`, `maskName`), the derivative sidecar (`derivativeSidecar(sidecar, description)`, `sidecarText`) and `gzipFile` of the DWI apps. degibbs, dwidenoise, n4, noddi and hmc use it in place of their own copies. Every output name and every file byte stays the same.

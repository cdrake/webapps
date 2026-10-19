---
"qsmbly": patch
---

Adopt upstream QSMxT's shared engine for magnitude/phase QSM, multi-echo CLEAR-SWI and T2*/R2* mapping. Its V-SHARP default omits deconvolution and its B0 direction follows the image affine; these intentionally change the previous browser map.

Preserve the Neurodesk workspace, shared examples, cancellation and field-map paths. Repair phase-sidecar and worker interoperability, validate echo grids and mixed-endian inputs, retain magnitude-only relaxometry through QSMxT's ARLO implementation, and report exact loaded dependency commits.

Pin the portable native command to the checksum-verified QSMxT 10.0.0 release. Validate the exact exported real-brain reconstruction command against the new browser with unchanged numerical tolerances and no B0 replay override. Keep the separate upstream Preact preview outside the monorepo app.

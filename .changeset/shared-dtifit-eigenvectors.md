---
"dwi2trx": patch
"@neurodesk/dwi2trx": patch
"noddi": patch
---

Rebuild the shared, file-pinned dtifit runtime from niimath cc26582a250c411b5c3c3c05c91dfd58f66be089 with Emscripten 6.0.13 so equal or nearly equal tensor eigenvalues retain unit, orthogonal directions. Record the source, toolchain, flags and licenses and cover the actual runtime with degenerate-tensor regressions. Re-record the production browser reference for V1–V3 because the repaired eigensolver changes the vectors and may reverse their arbitrary signs; scalar maps, tensor coefficients, the mask and every header remain byte identical.

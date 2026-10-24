---
"@neurodesk/n4": patch
---

`scripts/build.sh --check` rebuilds the N4 WebAssembly module and fails unless `n4-bias.wasm` and `n4-bias.mjs` equal the committed files. The build sets `SOURCE_DATE_EPOCH`, so ANTs' compiled-in build date no longer changes the bytes, and the weekly `n4-wasm-source` workflow runs the check. The committed module is unchanged.

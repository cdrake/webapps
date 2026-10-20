---
"@neurodesk/hmc-registration": minor
---

Add `@neurodesk/hmc-registration`: ANTs `antsRegistration` (3D float only) in WebAssembly at ANTs 52bc0ab and the ITK-Wasm toolchain of `packages/registration`, with a generic `run(argv)` over a virtual file system, a SHA-256-checked Node entry and a module worker entry. `run` refuses argv without `--float 1` or an explicit `--random-seed`. The kernel uses one ITK thread and starts at 256 MiB. On the committed synthetic pair it recovers the known rigid shift and writes the same `.mat` as native `antsRegistration`, byte for byte, in Node and in a Chromium worker. `packages/registration` is unchanged.

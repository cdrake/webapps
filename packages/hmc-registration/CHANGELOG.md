# @neurodesk/hmc-registration

## 0.1.0

### Minor Changes

- 7ed7289: Add `@neurodesk/hmc-registration`: ANTs `antsRegistration` (3D float only) in WebAssembly at ANTs 52bc0ab and the ITK-Wasm toolchain of `packages/registration`, with a generic `run(argv)` over a virtual file system, a SHA-256-checked Node entry and a module worker entry. `run` refuses argv without `--float 1` or an explicit `--random-seed`. The kernel uses one ITK thread and starts at 256 MiB. On the committed synthetic pair it recovers the known rigid shift and writes the same `.mat` as native `antsRegistration`, byte for byte, in Node and in a Chromium worker. `packages/registration` is unchanged.

### Patch Changes

- c288817: Reject malformed MATLAB transform headers before reading names or values, so invalid lengths and dimensions cannot stall the public reader. Preserve float and double transforms, including empty fixed-parameter matrices.

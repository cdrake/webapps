# QSMbly command line

QSMbly's portable command line is QSMxT 9.22.0, the native build of the
pipeline the web app runs. The app compiles qsm-core v0.38.0 and qsmxt-config
v9.22.0 to WebAssembly (`apps/qsmbly/rust-wasm`); QSMxT 9.22.0 is the release
built from that qsmxt-config tag, on the same qsm-core tag. The command the
app's Export dialog prints runs unchanged with `qsmbly` in place of `qsmxt`.

The package does not compile QSMxT. `qsmxt.json` pins QSMxT's own release
archive for each target by SHA-256, and `pnpm --filter @neurodesk/qsmbly build`
stages the host's archive in `native/`:

| Target | QSMxT archive |
| --- | --- |
| linux-x64 | `x86_64-unknown-linux-musl`: static, unlike the glibc build, which needs glibc 2.39 |
| windows-x64 | `x86_64-pc-windows-msvc` |
| macos-arm64 | `aarch64-apple-darwin`, re-signed with the release's Developer ID |

`bin/qsmbly.js` adds two commands and guards native QSMxT execution:

- `self-check` prints the runtime and QSMxT version as JSON.
- `download-models [--model ID ...] [--cache-dir DIR]` fetches deep-learning
  weights for offline use.

The weights (19 files, 1.7 GB) are not in the release (`bundleModels: false` in
`release.json`). `model.manifest.json` lists every model in qsm-core v0.38.0's
registry at a pinned commit of the Hugging Face repository
`qsmxt/qsm-onnx-weights`, with the registry's SHA-256. The build checks all
hosted cache filenames, sizes and checksums against the pinned Rust registry.

Native QSMxT has no offline switch and its model downloader ignores proxy
environment variables. Before any native processing command, including
QSMART, the wrapper therefore verifies the complete 19-file registry in one local directory.
Missing weights download from pinned URLs into
`~/.cache/neurodesk/qsmbly/models`. This first-use download is 1.7 GB,
including for a classical reconstruction. Later runs verify the cached
files and use no model network requests. Help, version, initialization,
BIDS validation, DICOM conversion, example downloads and `run --dry` need
no weights.

Both `QSMBLY_OFFLINE=1` and `NEURODESK_OFFLINE=1` forbid wrapper downloads.
An incomplete offline cache fails before QSMxT starts. Both native model
environment variables point at the same complete verified directory, so
QSMxT never falls back to its mutable model URLs. Set
`NEURODESK_QSMBLY_MODEL_DIR` to a complete model pack to avoid user-cache
copies. The launcher preserves this override and sets `NEURODESK_OFFLINE`
automatically only for releases that bundle models.

`download-models --model ID` can still fetch individual files. Native compute
requires the complete registry, so use `download-models` without `--model`
before taking the command line offline.

Native example downloads use a commit-pinned mirror on the Neurodesk Hugging
Face dataset. `examples.manifest.json` lists all 23 acquisitions (2.99 GB in
total); only the selected acquisitions download. The build checks their
filenames, sizes and checksums against QSMxT's pinned example registry.
`QSMXT_EXAMPLE_BASE_URL` is always set to this mirror for native execution.
Native QSMxT verifies each archive before unpacking it.

Offline mode disables `example` downloads. `example --list`, command help
and processing local data remain available offline. Prepare example data
while online, then use `run` offline with the complete model cache.

Native `slurm` and `tui` execution are unavailable in both modes. Their
scheduler jobs invoke QSMxT directly and bypass the wrapper's verified model
preflight; the TUI can generate and submit those jobs internally. Their help
remains available. Write scheduler scripts that invoke `qsmbly run` instead.

The wrapper refuses `qsmbly update`, which would replace the pinned binary.

## Validation

`validation/cli-check.mjs --executable PATH` stages the app's example
(`apps/qsmbly/examples.json`) as a BIDS dataset, runs the command the app
exported for it, and compares the χ map with the browser's. The browser
reference is a fingerprint, not the map: mask and support voxel counts,
percentiles, and mean χ in 10-voxel blocks (`validation/measure.mjs`).
WebAssembly SIMD and native code sum in different orders, so the maps are not
bit-identical; `browser-reference.json` records the tolerance and the
agreement observed when it was set.

To record a new reference after the app or qsm-core changes:

```bash
pnpm --filter qsmbly build
node packages/qsmbly/validation/browser-reference.mjs
pnpm --filter @neurodesk/qsmbly build
node packages/qsmbly/validation/cli-check.mjs
```

Recording keeps `tolerance` and `observed`; review them against the new
comparison. The pinned QSMxT must stay on the app's qsm-core tag:
`test/node.test.js` reads `apps/qsmbly/rust-wasm/Cargo.toml`. QSMbly patches
qsm-core with RS2-Net for rodent masks; QSMxT has no RS2-Net op, which the
app already notes in the exported command.

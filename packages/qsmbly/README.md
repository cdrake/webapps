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

`bin/qsmbly.js` adds two commands and passes every other one to QSMxT:

- `self-check` prints the runtime and QSMxT version as JSON.
- `download-models [--model ID ...] [--cache-dir DIR]` fetches deep-learning
  weights for offline use.

The weights (19 files, 1.7 GB) are not in the release (`bundleModels: false` in
`release.json`). `model.manifest.json` lists every model in qsm-core v0.38.0's
registry at a pinned commit of the Hugging Face repository
`qsmxt/qsm-onnx-weights`, with the registry's SHA-256. Before QSMxT starts, the
wrapper downloads the weights the command names (an algorithm such as
`--qsm-algorithm xqsm`, a mask op such as `hd-bet`, or segmentation and
chi-separation flags) into `~/.cache/neurodesk/qsmbly/models` and verifies them.
QSMxT finds them through `QSM_MODEL_DIR` and `QSM_MODEL_CACHE`. A model the
scan misses is fetched by QSMxT itself from its unpinned upstream URL; QSMxT
checks the same SHA-256 before using it. `QSMBLY_OFFLINE=1` forbids the
wrapper's downloads. The launcher's `NEURODESK_OFFLINE` does not apply: it
marks releases that bundle their models.

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

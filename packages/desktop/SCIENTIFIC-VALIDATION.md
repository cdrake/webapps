# Scientific validation for desktop automation

Run these checks on the PR branch before treating a new machine or backend as
scientifically verified. They use real models and pinned FreeSurfer reference
segmentations. Desktop unit tests use process fixtures and do not establish
scientific parity.

## Apple silicon

Install the repository's Node/pnpm dependencies, stable Rust, Python 3, Xcode
command-line tools and Chromium. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
bash scripts/desktop/verify-scientific-macos.sh all
```

The script runs sequentially and stops at the first failure. It prints an
external scratch directory containing the commit, machine/GPU information,
command logs, exit status and JSON evidence. Leave the Mac awake. Allow time
for model downloads, compilation and CPU inference. Full-volume inference
needs considerably more memory than the small fixture. Close other memory
intensive applications first.

Run one stage when investigating a failure:

```sh
bash scripts/desktop/verify-scientific-macos.sh native
bash scripts/desktop/verify-scientific-macos.sh webgpu
bash scripts/desktop/verify-scientific-macos.sh extraction
bash scripts/desktop/verify-scientific-macos.sh probe
```

| Stage | What must run | Evidence |
| --- | --- | --- |
| `native` | Small real fixture, then 1 mm and 2 mm heads in both modes on **CPU and Metal**; desktop native adapter on the same six cases | `native-parity.json`, `native-automation/validation.json` and per-run reports |
| `webgpu` | Two small-fixture modes and four full-volume cases in headed Chromium using Metal | `webgpu.json`, including adapter identity, limits, input/model/output hashes, voxel differences and hippocampal volumes |
| `extraction` | Real MindGrab with its CPU backend, then real SynthStrip with ONNX Runtime WASM | `extraction.json` and `extraction.log`; binary mask and input geometry checks |
| `probe` | Adapter identity and buffer planning only, without model download or inference | `webgpu-probe.json`; this is not scientific parity evidence |

`native` sets `SYNTHSEG_REAL_DEVICES=cpu,metal`, so an unavailable Metal device
fails instead of silently skipping it. The native adapter itself follows the
installed executable's default backend, normally Metal on macOS. Its report
records the backend actually used. The native Rust parity suite also checks
NIfTI header codes, units and quaternion fields.

The parity gates are unchanged: at most 5e-6 mismatched voxels on the small
fixture, 2e-6 on full volumes, and maximum affine error 1e-4. The browser and
native adapter checks also verify reports against the actual downloaded label
map, including checksums and per-label counts/volumes. Reported volumes use
the absolute affine determinant and declared spatial units; they are not
rounded to a presumed 1 mm voxel size.

`webgpu.json` records the adapter's `maxBufferSize` and
`maxStorageBufferBindingSize`. It plans buffers for 192×224×160 and
192×256×256 grids without allocating them. This distinguishes the advertised
adapter capacity from SynthSeg's validated 2 GiB single-buffer limit. A
reported 4 GiB adapter limit alone does not validate larger inference. The
script does not raise the cap. Extending it requires a separate larger-volume
oracle and parity run on the target hardware.

## Linux CPU

The native check also runs on Linux. `TMPDIR` must point to writable scratch
storage. These commands exercise real inference and the desktop adapter:

```sh
export SYNTHSEG_REFERENCE_DIR="${TMPDIR%/}/synthseg-references"
export CARGO_TARGET_DIR="${TMPDIR%/}/synthseg-target"
SYNTHSEG_REAL_DEVICES=cpu make -C exes/synthseg test test-real
export NEURODESK_SYNTHSEG_BIN="$CARGO_TARGET_DIR/release/synthseg"
node scripts/desktop/native-scientific-smoke.mjs
```

The adapter script writes a new `neurodesk-native-parity-*` directory under
`TMPDIR`, containing each output/report and `validation.json`. Setting
`NEURODESK_SCIENTIFIC_OUTPUT` selects a new, nonexistent output directory.
Unset `SYNTHSEG_REFERENCE_DIR` to run only the two small-fixture cases; the
result explicitly identifies that reduced scope. `make test-real` updates
`exes/synthseg/validation/report.json`; retain the result as evidence rather
than accidentally replacing an existing hardware report in a commit.

CPU-only browser extraction checks do not require a GPU:

```sh
pnpm --filter brain-extraction build
BRAIN_EXTRACTION_REAL_MODELS=1 pnpm --filter brain-extraction exec playwright test --grep 'real model'
```

These extraction checks establish working real-model inference, geometry and
binary-mask invariants. They do not claim FreeSurfer segmentation parity or
MindGrab GPU parity.

## Interpreting a result

A successful report names every case and backend that ran. A skipped test,
missing JSON file, partial report or nonzero exit is incomplete validation.
The macOS helper restores the pre-existing native report after preserving the
new result in its evidence directory. The browser writes directly to that
directory. Share the evidence directory or its logs and JSON files when a
check fails.

Hosted macOS CI selects CPU for full-volume SynthSeg tests because of its
memory budget. A hosted full-volume CPU success does not establish full-volume
Metal or WebGPU parity. The small fixture, full-volume native Metal and
browser WebGPU checks are separate results.

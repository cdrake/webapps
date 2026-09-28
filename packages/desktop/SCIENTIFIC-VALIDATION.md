# Validate scientific workflows on Apple silicon

Run the PR branch on a Mac before treating its hardware backends as verified.
The helper runs real inference and saves the evidence outside the checkout.
Desktop unit tests and a GPU capability probe do not establish scientific parity.

## Prepare the Mac

Use a native arm64 terminal, Node.js 24, pnpm, Python 3, rustup, and the Xcode
command-line tools. Install the pinned Rust toolchain needed to build SYNcro's
threaded Greedy kernel:

```sh
rustup toolchain install stable
rustup toolchain install nightly-2025-11-15 --component rust-src --target wasm32-unknown-unknown
cargo +stable install wasm-pack --locked
```

Check out the PR and install its JavaScript dependencies and test browser:

```sh
gh pr checkout 99
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Run every stage from the repository root:

```sh
caffeinate -i bash scripts/desktop/verify-scientific-macos.sh all
```

Keep the terminal open. The script builds each browser app before testing it
and runs stages sequentially. Allow time for compilation, model downloads,
and CPU inference. Native SynthSeg CPU inference can use about 14 GB on the
1 mm head. A 16 GB Mac can swap. Close other memory-intensive applications.

The helper prints its evidence directory under `TMPDIR`. macOS normally sets
`TMPDIR`; to use another scratch volume, set it to an existing writable
directory before running the command. References, compiler output, browser
traces, and catalog example downloads stay there. Native SynthSeg currently
requires its 53 MB model at `exes/synthseg/models/synthseg-2.0.onnx` because its
build embeds that fixed path. The file is ignored by Git. A `webgpu`-only run
keeps its model in the evidence directory instead.

## Run a single stage

To investigate or resume after a failure, replace `all` with one stage:

```sh
caffeinate -i bash scripts/desktop/verify-scientific-macos.sh catalog
```

| Stage | Required execution | Evidence |
| --- | --- | --- |
| `probe` | Headed Chromium on the Apple GPU; buffer planning without inference | `webgpu-probe.json`, `probe-tests.json`, `probe.log` |
| `native` | Small fixtures and four full-volume cases on CPU and Metal, followed by the native desktop adapter's six cases | `native-parity.json`, `native-automation/validation.json`, per-run outputs and reports, logs |
| `webgpu` | Two small-fixture modes and four full-volume cases in headed Chromium on Metal | `webgpu.json`, `webgpu-tests.json`, `webgpu.log` |
| `extraction` | MindGrab CPU and SynthStrip ONNX Runtime WASM on the real fixture | `extraction.json`, build and inference logs |
| `catalog` | Brain2Print, DWI tractography, SYNcro, and TopoFit main workflows below | `catalog-fixtures.json`; each app's `playwright.json`, `reports.json`, `run.log`, and traces under `catalog/` |

`all` starts with `probe`. `catalog` also runs the probe before its workflows.
Both reject a software GPU. `hardware.json` records the Mac, operating system,
and display adapters without serial numbers. The browser probe records the
adapter actually exposed to Chromium, its features, and buffer limits.
`commit.txt`, `worktree.txt`, the copied lockfile and model manifests identify
the source and dependencies used. Use a clean checkout for a reproducible run.

## Check the catalog workflows

The helper supplies all inputs automatically. It reads the apps' example
manifests, downloads revision-pinned files, and verifies their sizes and SHA-256
checksums against `registry/offline-assets.lock.json`. Each reuse verifies the
cache again. No private dataset or unexplained environment variable is needed.

| App | Input selected by the helper | What completion establishes |
| --- | --- | --- |
| Brain2Print | Committed `exes/synthseg/test/fixtures/small.nii.gz`, already used by its hardware regression tests | `16chan18cls` segmentation on WebGPU; corrected STL, MZ3, and segmentation downloads; a closed, consistently wound mesh with positive volume |
| dwi2trx | The app's `dwi-gradients` example: `dwi.nii.gz`, `dwi.bval`, and `dwi.bvec` | Tensor fitting and hardware WebGPU tracking with subgroups; hashed FA, V1, and TRX outputs; no seed-cap or memory truncation |
| SYNcro | The T1 primary image from its pinned `trace-t1` stroke example | SynthSR WASM, SynthStrip WASM, and Greedy normalization; native synthetic T1 and three normalized images; MNI dimensions and output hashes |
| TopoFit | Its pinned `openneuro-t1` example, also used by reconstruction validation | ONNX Runtime WASM reconstruction; six anatomical surfaces, two registration spheres, QC, and the processing manifest with model hashes |

SYNcro and TopoFit use CPU inference in these checks. Their results do not
establish GPU inference parity. DWI reports whether MindGrab masking succeeded
or the existing unmasked fallback ran. A capped or truncated tractogram leaves
catalog validation incomplete. These workflow checks establish the listed
artifacts and invariants; they do not add a new scientific reference oracle.
They do not cover every segmentation model, optional lesion, or TopoFit patch
setting.

The helper sets these existing test inputs to absolute paths:

| Test variable | Path used by `catalog` |
| --- | --- |
| `DWI2TRX_FIXTURE_DIR` | `<fixture-cache>/dwi2trx`, containing the three `dwi.*` files |
| `SYNCRO_AUTOMATION_IMAGE` | `<fixture-cache>/syncro/sub-101_T1w.nii.gz` |
| `TOPOFIT_AUTOMATION_IMAGE` | `<fixture-cache>/topofit/sub-01_T1w.nii.gz` |

The default fixture cache is `$TMPDIR/neurodesk-scientific-fixtures`.
Set `NEURODESK_SCIENTIFIC_FIXTURES` to another cache directory if needed.
The helper replaces the three per-test variables above with its verified paths.
Models download through each app's existing pinned loader. Keep internet access
available for the first run. SYNcro's first production build compiles Greedy;
a missing nightly toolchain or `wasm-pack` is a failure, not a skipped workflow.

Catalog traces are retained even for passing tests. The helper extracts the
actual completed automation reports into each app's `reports.json`, including
input and output hashes, processing parameters, measurements, and provenance.
The tests verify each downloaded artifact against those hashes. Browser download
files themselves are temporary; the traces and extracted reports remain.

## Interpret the evidence

Read `stages.json` and `exit-code.txt` first. A stage is `completed` only after
its expected tests and required evidence pass. Skipped, missing, retried, or
failed tests cause a nonzero exit. `pending` means an earlier stage stopped the
run. `not-requested` identifies stages outside the selected command. A partial
run has status `incomplete`. The helper stops at the first failure and preserves
its logs and any available evidence. Share the evidence directory when a check
fails.

Native SynthSeg sets `SYNTHSEG_REAL_DEVICES=cpu,metal`; an unavailable Metal
device fails. Its desktop adapter uses the executable's default backend,
normally Metal on macOS, and records the actual backend. The helper preserves
and restores any pre-existing `exes/synthseg/validation/report.json` after saving
the new result as `native-parity.json`.

SynthSeg's existing parity gates remain unchanged: at most 5e-6 mismatched
voxels on the small fixture, 2e-6 on full volumes, and affine error at most
1e-4. Report volumes use the absolute affine determinant and declared spatial
units. The native and browser checks compare those reports with the actual
label maps, including label counts, volumes, and hashes.

The probe plans buffers for 192×224×160 and 192×256×256 without allocating
them. It records `maxBufferSize` and `maxStorageBufferBindingSize` separately
from SynthSeg's validated 2 GiB single-buffer cap. The helper does not raise
the cap. An advertised 4 GiB adapter limit does not validate larger inference;
that needs its own reference output and parity run on the target hardware.

Hosted macOS CI uses CPU for full-volume SynthSeg cases because of its memory
budget. Hosted CPU success does not establish native Metal or browser WebGPU
parity on your Mac.

## Run the CPU checks on Linux

Set `TMPDIR` to writable scratch storage, then run real native inference and
the desktop adapter:

```sh
export SYNTHSEG_REFERENCE_DIR="${TMPDIR%/}/synthseg-references"
export CARGO_TARGET_DIR="${TMPDIR%/}/synthseg-target"
SYNTHSEG_REAL_DEVICES=cpu make -C exes/synthseg test test-real
export NEURODESK_SYNTHSEG_BIN="$CARGO_TARGET_DIR/release/synthseg"
node scripts/desktop/native-scientific-smoke.mjs
```

The adapter writes a `neurodesk-native-parity-*` directory under `TMPDIR` with
outputs, reports, and `validation.json`. `NEURODESK_SCIENTIFIC_OUTPUT` selects a
new, nonexistent output directory. Without `SYNTHSEG_REFERENCE_DIR`, the adapter
runs only the two small-fixture cases and records that reduced scope.
`make test-real` updates the native validation report; retain the evidence
without committing a replacement for another machine's report.

CPU browser extraction needs no hardware GPU:

```sh
pnpm --filter brain-extraction build
BRAIN_EXTRACTION_REAL_MODELS=1 pnpm --filter brain-extraction exec playwright test --grep 'real model'
```

These checks establish real-model execution, geometry, binary masks, and report
integrity. They do not establish MindGrab GPU or FreeSurfer segmentation parity.

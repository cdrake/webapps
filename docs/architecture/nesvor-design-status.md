# NeSVoR implementation status

The user authorized implementation after design and review. Linux x86-64 with an
NVIDIA GPU is the first backend target. Full browser-native reconstruction is
still required; the experimental CPU reference does not satisfy that requirement.

## Review findings

| Finding | Current result | Evidence |
| --- | --- | --- |
| Result identity follows mutable inputs | Fixed: immutable filename snapshot, locked inputs, atomic imports and serialized viewer loads | App production tests include input locking and failed-import preservation |
| Disconnect retains credentials | Fixed: installation code cleared after pairing; separate credential in tab session storage, cleared and revoked on disconnect; old local-storage tokens discarded | Shared connection tests, including reload and disconnect |
| Slice thickness inferred from spacing | Non-blocking spacing estimate note; both engines can run without acknowledgement. Thickness stays editable and must be positive. | Production app workflows |
| NIfTI-only input | Fixed: shared local DICOM importer, preserving multiple series | Production upload workflow covers extensionless multiseries input |
| Simulators used as scientific evidence | Separate real CUDA gate implemented; actual scientific run remains outstanding | `scripts/verify-nesvor-real.mjs` refuses simulated execution, checks pinned inputs and scientific outputs |
| Browser engine absent | WebGPU fitting, registration, optional methods and worker output implemented; full-acquisition validation remains unfinished | `packages/nesvor`, worker production test, explicit limitations in app and provenance |
| Installation-wide job ownership | Fixed: paired client ownership across every job endpoint | Rust integration and shared conformance tests |
| Jobs lost on restart | Fixed: atomic durable metadata, startup reconciliation, retention and data-directory locking | Rust recovery tests |
| Duplicate submission and no recovery | Content-checked owner-scoped idempotency and tab reload job recovery implemented. Early upload receipts and resumable/chunked uploads remain unfinished | Protocol conflict/retry tests and production reload recovery test |
| Cancellation reports completion early | Fixed: separate cancelling state, process termination confirmation, explicit terminal deletion | Slow-runner and process-group tests |
| Backend archive lacks frontend/download | Linux archive now includes release binary, production frontend, launch script, checksums and runtime manifest. Draft publication workflow prepared; no public download or offline scientific runtime claimed | Archive extraction/dependency tests; locally built archive |

## Browser implementation scope

The reduced CPU reference is explicitly experimental and requires prealigned
NIfTI stacks with reviewed masks. It uses a fixed reduced preset: 100 iterations,
batch 4, four PSF samples, 256 hash entries per level and MLP width 16. It rejects
more than 20,000 masked observations or 32,768 output voxels without downsampling.
It performs actual per-case differentiation, optimization and volume sampling in
a worker, preserves scanner-space output geometry, and supports cancellation.

A separate experimental WebGPU option now runs the selected training settings in
a worker. Forward/backward, uncertainty and pose losses, accumulation and AdamW
are implemented. A full update matches an actual pinned upstream PyTorch fixture.
Three intersecting synthetic stacks run through fitting, fitted-pose support,
output PSF sampling, intensity normalization, NIfTI output and cancellation.

SVoRT preprocessing, learned graph execution, transform corrections and rigid
candidate comparison are implemented, and the learned registration path
has passed a bounded fetal-input integration test. It has not passed a
full-acquisition test. Both real frozen subgraphs exported and
ran in Chromium WASM. Their largest tested coordinate difference from PyTorch was
0.000550 mm against a 0.001 mm bound. The bound is for subgraph numerics only.
Exports are published with attribution at pinned Hugging Face dataset revision
c5b3a2674369c0c619d726bb177a9c0a74d2e356 and registered in the offline inventory.
Chromium downloaded and verified both hosted graphs and reproduced the same
learned predictions. NESVOR_MODEL_DIR optionally stages models locally.

The actual learned feedback pipeline passed four iterations on nine retained
masked slices from three pinned fetal stacks, using the unchanged 200³ SRR grid.
It ran default VVR and NCC candidate selection, selected the SVoRT candidate
at NCC 0.9272 versus 0.7748, and propagated finite rigid transforms to all 15
retained slices. The software-hosted run took 376 seconds. This fixture uses
positive-intensity masks and an explicit 3 mm test thickness assumption; it is
not a confirmed acquisition or an upstream full-pipeline numerical comparison.

Otsu masking, stack intersections, MONAIfbs automatic masks, ITK N4 and deformation
with its analytic Jacobian regularizer are implemented. MONAIfbs runs the original
MONAI 0.3.0 architecture; current MONAI versions cannot load that checkpoint.
Its eight-augmentation pipeline produced identical masks on three central slices
of the pinned fetal example, 4,086 foreground voxels and zero disagreements.
N4 matches SimpleITK fixtures within 1.53e-5 intensity units, with one case
bit-identical. The integrated deformable objective, gradients and AdamW update
match upstream PyTorch within 9.6e-8, 6.0e-8 and 7.5e-9 respectively. That oracle
uses a disclosed smoothstep encoder shim for an upstream CPU incompatibility.

N4 and deformation also run together through the actual worker and production
app, retaining 256 training PSF samples and 512 output samples. Model/runtime
assets are published with attribution, pinned digests and offline records. The registration/SRR
operators and PSF/loss/pose stages also need throughput work on real GPU hardware.
The host's software adapter is not performance evidence. CUDA parity and a
complete default-budget reconstruction remain unverified.

## Verification

- Rust backend: 30 unit tests and 11 integration tests; clippy and formatting pass.
- Shared components: 120 tests pass.
- Browser numerical package: 43 tests pass, including upstream fixtures, preprocessing, geometry, deformation and cancellation.
- Both protocol implementations have a 14-test conformance suite, including changed-content retry rejection.
- Release source checks validate date versions and synchronized linked packages. `pnpm release` applied versions/changelogs; the frozen lockfile is synchronized.
- The complete production site builds successfully. NeSVoR passes desktop/phone interface audits, mobile layouts, retained-settings workflows and real DICOM series conversion. Screenshots were reviewed in light and dark themes.
- All 11 production app tests pass and cover hosted example import, simulator round trip, cancellation, server errors, reload recovery, a local reference fit/download, combined browser N4/deformation fit/download, and failed-import identity preservation.
- Linux archive was rebuilt locally with the 0.3.20260921 production frontend and verified static dependencies. Its launcher served the frontend and isolated JavaScript assets, paired a client and revoked that client successfully. The archive deliberately excludes Docker, drivers, container layers and model weights.

The real CUDA example, offline model readiness and numerical browser/container
parity have not been run. This host has no visible NVIDIA GPU. Docker is
readable through sudo, but it has no NVIDIA runtime or cached pinned NeSVoR image. The real validation command and manual NVIDIA-runner workflow
fail rather than substitute simulation. The user confirmed there is no reachable GPU backend yet. Publication remains pending those gates.

## Design record

See [webapp design](nesvor-webapp-design.md), [browser design](nesvor-browser-design.md),
[source research](nesvor-research.md), [browser research](nesvor-browser-research.md),
[implementation review](nesvor-implementation-review.md), and
[decision log](nesvor-implementation-decisions.tsv).

## Full browser implementation run

Completion requires a browser worker to process a suitable pinned acquisition
through the upstream registration, training and sampling stages, with numerical
checks against upstream and no examination upload. A reduced model, a simulator
or a passing build does not satisfy this condition.

- [x] Re-read execution principles and inspect the current implementation.
- [x] Establish CPU PyTorch for independent numerical fixtures.
- [x] Verify WebGPU field forward, backward, accumulation and optimization.
- [x] Integrate full effective batches, PSF loss, uncertainty and pose derivatives.
- [x] Export and verify frozen SVoRT networks; integrate registration selection.
- [x] Verify and integrate fitted-pose support masks and output sampling.
- [x] Complete preprocessing and optional advertised methods.
- [ ] Run a real browser acquisition, cancellation and download workflow.
- [ ] Compare browser reconstruction with pinned upstream numerical outputs.
- [x] Build, run interface checks, review screenshots and update release metadata.

The default training budget is 6,000 updates of 4,096 pixels and 256 PSF samples.
Microbatching must preserve that objective and optimizer update boundary. The
first executable GPU field uses the upstream PyTorch hash layout and float32;
CUDA tiny-cuda-nn parameter layout and mixed precision differ and require a
separate comparison. Software WebGPU can verify kernels here, but cannot establish
clinical-volume hardware throughput. No reachable NVIDIA backend is available.

### Current numerical evidence

43 package tests pass. Chromium SwiftShader's full GPU update differed from the
upstream CPU fixture by at most 3.38e-8 in losses and 7.46e-9 in updated parameters.
The independent rigid-registration oracle had maximum transform error 9.92e-7.
These fixture-level checks do not satisfy the full browser completion predicate.

### Remaining acceptance work

The methods exposed in the current app are implemented. The following acceptance
checks remain open; they are not replaced by component fixtures:

1. Run all six acquisition stacks at the default 6,000-update budget on real
   WebGPU hardware, recording memory, elapsed time, output and cancellation.
   `scripts/verify-nesvor-browser.mjs` drives the production app and rejects
   software adapters and reduced presets. See the package README for invocation.
2. Compare complete browser fitting trajectories and reconstructed images against
   the pinned CUDA container. There is no reachable NVIDIA backend in this session.
3. Establish useful throughput. The JavaScript acquisition/SRR and host PSF/loss
   calculations remain candidates for GPU implementation. A small successful fit
   is not evidence that the default clinical-sized workload is practical.
4. Validate full frozen registration decisions and motion estimates against
   upstream, then establish reconstruction-quality acceptance criteria with
   suitable full acquisitions. Component numerical parity is insufficient.

Browser output stays explicitly experimental and its provenance keeps
`validated: false`. Browser reload recovery/checkpointing is not part of this
release; remote jobs retain the server's durable lifecycle.

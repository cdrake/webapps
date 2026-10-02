# Browser-native NeSVoR reconstruction

Browser reconstruction is required in the same port as the Linux/NVIDIA server. This document expands the [main design](nesvor-webapp-design.md). It is a design, not a report of implemented or measured browser performance. The [browser source analysis](nesvor-browser-research.md) records the underlying operations.

## Completion contract

Given the same supported fetal stack bundle, reviewed masks, confirmed thicknesses and reconstruction settings, either execution mode produces an isotropic NIfTI and provenance. The browser performs preprocessing, SVoRT v2 initialization, the selected registration procedure, case-specific fitting and volume sampling without a backend. Its registration must preserve the `svort` preset's comparison with stack registration and refinement behavior. Downloading static pinned model weights is allowed; uploading examination data is not.

An exported network forward pass, fixed-transform fitting, a phantom with registration disabled, or a remote result shown in the viewer cannot satisfy browser completion. Those can be intermediate numerical tests. Both engines must pass the same real-example acceptance criteria before this port is complete.

## Caller usage and ownership

The app prepares a versioned scientific request once. Selecting a mode changes execution, not scientific defaults. Illustrative proposed API:

```js
const engine = execution.kind === "browser"
	? await createBrowserReconstructor({ onStage, signal })
	: await createRemoteReconstructor({ connection, onStage, signal });
const prepared = await engine.prepare(request, { signal });
if (prepared.kind === "unsupported") {
	showCapabilityFailure(prepared.reasons);
	return;
}
const run = await prepared.start({ onReceipt, signal });
await run.observe(renderState, { signal: observationSignal });
const image = await run.download("reconstruction", { signal });
```

`prepare` returns either an unsupported result or a prepared handle containing `start()`. It binds immutable inputs, settings, input revision and execution destination. It checks the complete preset and estimated allocations, not merely `navigator.gpu`. Preparation never uploads patient data. Starting rechecks live device/connection readiness; allocation can still fail. Editing inputs, settings or destination invalidates the prepared handle. The browser factory owns worker/device lifetime; the remote factory delegates transfer and authentication to `packages/remote-compute`. Neither exposes shader dispatch or HTTP envelopes to the app.

Factory and preparation signals cancel initialization only. The start signal controls admission and, remotely, transfer/submission. Once a run is admitted, cancellation requires `run.cancel()` in either mode. A remote submit abort after receipt creation leaves the durable draft/job recoverable and does not imply server cancellation. A browser start abort before admission creates no run; after admission it does not terminate an unseen worker. The API must provide the run identity/handle at admission, even if later transfer fails. Observation abort only detaches progress reporting. These lifecycle rules belong in contract tests.

```text
Execution = Browser | Remote(authenticatedConnection)
RunIdentity = BrowserRun(sessionId, runId)
            | RemoteRun(serverId, ownerId, jobId)
RunState = Preparing | Running(stage, progress) | Cancelling
         | Succeeded(artifacts, provenance) | Failed(problem)
         | Cancelled | Interrupted(problem)
```

Remote-only upload and queue detail accompanies the run without becoming a fake browser lifecycle. `onReceipt` receives a discriminated identity and durability capability. A browser receipt identifies a session-local run; saving it does not save optimizer state or grant reload recovery. Remote receipts retain the durable semantics in the main design. Only the remote session lists and reopens durable jobs.

`packages/nesvor` owns the scientific specification, preprocessing/geometry, SVoRT adapter, differentiable model, optimizer and output interpretation. Organize the package by those responsibilities, with a worker entry and private WGSL kernels. CPU-heavy geometric routines may use Rust/WASM; use existing shared file import, NIfTI handling, downloads and workers. Do not fork these helpers into the app.

Keep reusable device/asset utilities in `packages/runtime-support` only where they have a clear shared role. The existing `gpu-unet` executor is model-specific inference, not a training engine. The ANTs registration package implements a different volume registration method and cannot substitute for NeSVoR's slice registration. Reuse established infrastructure without changing the science to fit it.

## Numerical implementation

Use explicit WGSL forward and backward kernels for the pinned NeSVoR objective, with CPU/WASM geometry where justified. A frozen SVoRT network can use ONNX Runtime Web if its actual exported operators, dynamic shapes and output values pass validation. Exporting SVoRT is only one part of the registration port; surrounding resampling, reconstruction, transforms and selection remain required.

| Responsibility | Required browser work |
| --- | --- |
| Input preparation | Preserve affine conventions, stack masks, thickness, intensity normalization, coordinates and slice order |
| Registration | SVoRT v2 inference, geometric preprocessing/postprocessing, stack registration, NCC comparison and refinement in the selected upstream mode |
| Differentiable representation | Multi-resolution hash encoding, interpolation, MLPs and all enabled per-slice parameters |
| Image formation | Stochastic point-spread-function sampling, coordinate transforms and gradients into the optimized rigid poses |
| Objective | Preserve upstream data terms, uncertainty/scale terms, regularization, reductions and explicit stop-gradient boundaries |
| Optimization | Exact resolved AdamW parameter groups, learning rates, decay, epsilon, moments, schedules and initialization semantics |
| Output | Chunked sampling of the fitted representation into the requested grid, correct atlas-space metadata and NIfTI serialization |

Inventory every enabled branch from the pinned source and actual container before implementation. N4 preprocessing and a learned bias field are different concepts; record the effective setting for each. The initial preset keeps learned bias disabled with `n-levels-bias=0`, matching the tagged default. Do not drop enabled uncertainty, optimized poses or regularizers to make an initial shader pass. Optional higher-order-gradient and deformable modes remain outside the selected initial preset in both engines.

Record the resolved optimizer configuration from the actual pinned PyTorch installation. Defaults inherited from a library are part of the numerical reference even if absent from the source argument list. Export fixtures containing initial parameters, sampled coordinates, targets, forward outputs, each loss component, gradients, and parameters/moments after one update. For deterministic component comparisons, feed identical draws to both implementations instead of assuming equal seed integers produce equal random streams.

WGSL's baseline atomics operate on integers. Do not design hash-table gradient updates around an assumed floating-point `atomicAdd`. Compare bounded segmented/tiled reduction against a carefully tested integer compare-exchange representation of float addition. The latter needs finite-value handling, collision stress tests and convergence/performance measurements. Prefer an ordered reduction for the reference implementation; optimize only after error and memory evidence. See the [WGSL atomic specification](https://www.w3.org/TR/WGSL/#atomic-builtin-functions).

Start with f32 parameters, gradient accumulation and optimizer moments. Measure differences against the CUDA mixed-precision path rather than claiming bitwise equality. Optional `shader-f16` acceleration follows parity tests. Do not require subgroups or a vendor-specific extension unless the resulting hardware restriction is deliberate and documented.

## Memory and execution budget

The upstream default fitting batch expands 4,096 samples into 256 PSF samples each, or 1,048,576 coordinate queries. Materializing every encoded feature and hidden activation at once is not a safe browser plan. The planner accounts for registration weights and scratch space, hash tables, gradients, Adam moments, activations, masks, input buffers, result grids and the viewer's GPU use.

Microbatch coordinate queries while preserving the effective upstream batch and reduction weights. Accumulate gradients, then perform one optimizer step per original batch. Maintain the same stochastic draws and nonlinear loss/normalization semantics across partitions. Changing batch size, PSF samples, output resolution or iteration count is a visible scientific setting change, not an automatic memory workaround.

For P f32 trainable scalars, parameters, gradients and two Adam moments alone require approximately 16P bytes. This excludes all activations, per-slice variables, registration and transfer buffers. Bound the largest binding as well as total working memory. WebGPU limits are not a reliable free-VRAM counter, so preflight estimates cannot guarantee allocation success. Release SVoRT intermediates before fitting when the algorithm no longer needs them; sample final volumes in bounded chunks.

Run computation in a dedicated worker, keep tensors GPU-resident through training, and read back bounded progress summaries. Submit bounded batches of GPU work so cancellation and device loss are observable. Release job-owned GPU buffers and worker resources before reporting cancellation complete. Handle shader validation errors, allocation failures and `device.lost` as explicit failed/interrupted runs with no published partial output.

A browser tab can be suspended or closed. Worker execution is not a durable background service. The first browser release promises completion only while its session remains active; it does not promise reload resume. Optional checkpoint persistence would need optimizer state, model configuration, stochastic state, protocol/version checks and explicit patient-data storage consent. Do not write examination data to IndexedDB or OPFS by default. Remote jobs retain server durability.

## Architecture alternatives

Two shapes were considered. The recommended shape uses an explicit model-specific forward/backward engine with a small scientific interface. This concentrates NeSVoR's numerical behavior and avoids building a general ML framework, at the cost of maintaining tested gradients and reductions.

The alternative uses a general browser tensor/autodiff runtime or exported training graphs. ONNX Runtime has a [browser training example](https://github.com/microsoft/onnxruntime-training-examples/tree/master/on_device_training/web); it is inaccurate to describe all browser runtimes as inference-only. That example does not establish WebGPU support for NeSVoR's hash encoding, custom acquisition operators, pose gradients or memory footprint. Select a general runtime only if a full representative training step proves operator coverage, memory behavior and numerical agreement with less maintained code. A small model training demo is insufficient evidence.

Keep the inference export option for frozen SVoRT where it passes operator and geometry tests. This does not introduce two training implementations. If the export fails, port the missing frozen-network operations locally rather than quietly sending registration to the server.

## Verification and delivery

The numerical export/comparison tool is a required implementation artifact. It runs against the pinned container and emits versioned manifests plus forward/backward/optimizer fixtures. Keep its source in the repo and its large data on pinned Hugging Face assets. A browser runner consumes those fixtures and records errors and hardware/runtime versions in a machine-readable report. Freeze acceptance thresholds before evaluating the port; do not loosen them to fit failures.

1. Verify transforms, interpolation, hash collisions, masked reductions and gradient accumulation independently. Compare analytic gradients to upstream and finite differences on small non-degenerate cases.
2. Verify each loss component and one complete optimizer step using identical state and samples. Test near-zero rotations, empty support, finite-value handling and parameter-group defaults.
3. Verify SVoRT and the complete registration decision path on the same stacks, including affine conventions and NCC selection. A generic registration substitute does not pass.
4. Compare full fitting trajectories and final geometry, reconstruction error and agreed quality metrics over repeated runs. Include real fetal stacks with supplied masks and all default enabled terms.
5. Measure runtime and peak planned/observed allocation behavior on actual target GPUs. Prove a useful full preset before calling a device supported. Start validation on desktop Chromium with NVIDIA and Apple silicon; additional devices/browsers enter the support matrix only after real runs.
6. Exercise local cancellation, tab loss, device loss, out-of-memory and input replacement. Confirm that none contacts the saved remote server or presents stale results.
7. Run the pinned example from cold packaged assets with every network route blocked and no backend installed. Separately verify remote mode and explicit switching in the same built UI.

Browser implementation and remote implementation can progress in parallel after the shared specification and numerical fixtures exist. If a browser milestone fails, redesign the affected numerical component and keep it open. A completed server does not remove browser reconstruction from scope.

# NeSVoR browser port

The browser engine performs per-case WebGPU fitting and NIfTI output, with SVoRT
or rigid registration, MONAIfbs brain masks, ITK N4 bias correction, Otsu masking,
stack intersections and optional deformation. These methods are implemented and
have component and integration checks. Full-acquisition reconstruction, CUDA
comparison and hardware throughput validation remain outstanding. The app keeps
the remote container and reduced CPU reference as separate execution options.

`runBrowserReconstruction` from `@neurodesk/nesvor/browser` launches a worker. Its
request contains NIfTI `ArrayBuffer` stacks, optional masks, confirmed physical
slice thicknesses and reconstruction options. It reports progress and supports
`AbortSignal` cancellation by terminating the worker. Examination data is local.
Learned preprocessing downloads pinned weights; it does not upload examinations.
The request's `runtime.wasmBaseUrl` points to the staged ONNX runtime directory.
N4 additionally uses `runtime.n4BaseUrl` for its same-origin staged runtime.
`runtime.modelBaseUrl` optionally selects locally bundled SVoRT graphs; otherwise
its manifest selects the pinned hosted models. The app supplies these URLs.

The GPU field implements the upstream PyTorch hash layout, density and uncertainty
MLPs, parameter and coordinate derivatives, collision-safe accumulation and
AdamW. The host computes Gaussian PSF samples, data and image losses, slice scales,
slice uncertainty and pose gradients in bounded observation chunks. Microbatches
accumulate before one optimizer update for the selected effective batch. Host
parameter gradients and moments allocate lazily. This implementation uses float32;
it does not reproduce tiny-cuda-nn's layout or mixed-precision execution.

Registration includes SVoRT crop/resampling, transform correction and propagation,
finite-difference rigid registration and candidate scoring. Frozen SVoRT inference
uses ONNX Runtime WASM. Its custom acquisition and SRR operators currently run in
JavaScript, which needs throughput work before full acquisitions are practical.
Output support follows upstream PointDataset.mask using fitted poses, followed by
isotropic resampling, PSF sampling and mean-intensity normalization to 700.

## Verification

- `pnpm --filter @neurodesk/nesvor test` checks derivatives, geometry, preprocessing,
  output support and an actual upstream PyTorch training fixture.
- `pnpm --filter @neurodesk/nesvor test:gpu` runs forward/backward, collision,
  accumulation, optimizer, cancellation and overflow checks in Chromium. A full
  training step is compared with the pinned upstream fixture.
- `pnpm --filter @neurodesk/nesvor test:workflow` runs three intersecting synthetic
  stacks through the actual worker, output encoding and cancellation, including
  combined N4 and deformable reconstruction.
- `node src/registration/verify-pipeline.mjs MODEL_DIRECTORY STACK_DIRECTORY`
  runs actual SVoRT graphs through four acquisition/SRR feedback iterations,
  default rigid candidate comparison and transform propagation on nine masked
  fetal-example slices. The SRR grid remains 200³. It tests pipeline execution,
  not full-acquisition parity.
- `node src/registration/verify-onnx.mjs EXTERNAL_EXPORT_DIRECTORY` checks frozen
  learned predictions in Chromium against PyTorch outputs. Coordinate tolerance
  is 0.001 mm; score tolerance is 0.0001. These tolerances concern learned subgraphs,
  not registration accuracy or clinical reconstruction quality.

Use `PLAYWRIGHT_BROWSERS_PATH` if Chromium is installed outside Playwright's default
cache. GPU checks here used SwiftShader and establish numerical behavior, not
hardware performance. The integration fixture deliberately uses one update and a
small hash table; default-budget reconstruction remains unverified.

## Model and runtime assets

`src/registration/export_svort.py` exports the real SVoRTv2 checkpoint in a pinned
NeSVoR source environment, checks ONNX predictions against PyTorch at two slice
counts, and writes a digest manifest. `svort-manifest.json` records the measured
exports. Model files stay outside this source repository.

Set `NESVOR_MODEL_DIR` to that external export directory when building the app.
`scripts/stage-nesvor-runtime.mjs` verifies both digests and stages the models and
ONNX runtime under ignored public directories. Without that variable, the build
removes previously staged models so it cannot accidentally ship stale weights.
Normal browser builds download the graphs from the pinned Neurodesk Hugging Face
dataset revision recorded in the manifest. Both assets are registered in the
offline inventory. Local staging supports deployments that bundle the models.

`src/training/export_reference.py`, `src/registration/export_registration.py` and
`src/output/generate-fixture.py` reproduce upstream CPU checks. The source commit
is `730ddaa3711a2304386de34193ea4b957892fe7b`. No passing test here establishes CUDA
container parity or suitability for clinical use.

MONAIfbs runs the original MONAI 0.3.0 checkpoint exported to ONNX. Its complete
preprocessing and eight augmentations produced identical masks on three central
slices from the pinned SVRTK fetal example. See [masking](src/masking/README.md).
The model is hosted at the commit pinned in `src/masking/manifest.json`.

N4 uses ITK 5.4.6 compiled to WebAssembly. App builds fetch the verified small
runtime into `TMPDIR`, then stage it under `public/n4`. `NESVOR_N4_DIR` optionally
supplies a local build. See [N4](src/n4/README.md) for SimpleITK oracle checks.

The [deformation module](src/deformation/README.md) differentiates the Jacobian
penalty analytically, with upstream detached-coordinate and embedding semantics.
The integrated full objective, gradients and optimizer match an upstream fixture.
Its CPU oracle explicitly supplies smoothstep interpolation because the pinned
upstream CPU encoder rejects that argument. CUDA parity is not implied.

## Full-acquisition hardware check

Build and serve the production app on the target machine, then run from the repo:

```sh
NESVOR_BROWSER_URL=http://127.0.0.1:4173 \
NESVOR_REPORT_DIR="$TMPDIR/nesvor-browser-report" \
NESVOR_EXAMPLE_THICKNESSES_MM=YOUR_CONFIRMED_THICKNESS \
node scripts/verify-nesvor-browser.mjs
```

The command downloads the complete pinned six-stack example, uses the fetal-brain
preset without reducing its budget, and saves output, provenance and a screenshot
outside the source repository. It rejects software adapters, reduced budgets,
missing preprocessing, unexpected uploads and invalid output geometry. Passing
this check establishes completion on that hardware, not clinical accuracy or
agreement with CUDA. Compare those saved outputs with the real container run
before declaring browser/container parity.

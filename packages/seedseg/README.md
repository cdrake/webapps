# SeedSeg command line

Run the web app's prostate fiducial-marker pipeline on a CPU. The shared pipeline
(`src/pipeline.js`) is the one the browser worker runs, with two models:

- **v2** (default): the nnU-Net v2 residual-encoder networks of five
  cross-validation folds, ported from upstream `scripts/deploy/seedseg_onnx.py`:
  QSM bias correction, crop to nonzero, z-score, resampling to the training
  spacing when it differs, Gaussian sliding window with optional test-time
  mirroring, softmax, the mean over the selected networks, and the K
  components of p > threshold with the highest mean probability. Each
  network's session exists only while it runs, so memory holds one network.
- **v1** (legacy): the previous release's consensus of four 3D U-Nets, unchanged.

```sh
seedseg self-check
seedseg image.nii.gz results --folds 0,1,2,3,4 --threshold 0.1 --top-n 3 --threads 4
seedseg image.nii.gz results-v1 --model v1 --ensemble 4
```

Portable releases include a private Node runtime, ONNX Runtime, QSM WASM and all
nine checksummed models (about 1.4 GB). They run offline from an empty home
directory. Linux and Windows use archives; Apple silicon uses a signed,
notarized installer when published. Local source usage needs
`pnpm --filter @neurodesk/seedseg build` and `seedseg download-models` before
`--offline` inference.

v2: `--folds` lists the networks to average (default `0`, as in the app;
`0,1,2,3,4` is the evaluated ensemble) and `--mirror` adds the seven mirrored
predictions of each patch (about 8 times slower). v1: `--ensemble 1` through `4`
selects the first checkpoints in published order and `--models 42,456` a
distinct subset; these two are mutually exclusive and do not apply to v2.
`--top-n` (or automation-compatible `--markers`) is K, 1–10; `--threshold`
accepts 0–1. `--threads` defaults to `SLURM_CPUS_PER_TASK`, or at most four
local cores.

Outputs match browser downloads. v2 writes `probability.nii` and `markers.nii`
(value r on the r-th marker) and reports each marker's mean probability, volume
and centroid (voxel and world mm) and the count flag (fewer than K candidates)
under `detections` on stdout. v1 writes `model1.nii` through `modelN.nii`,
`avgProb.nii` and `consensus.nii`. Dimensions and affine come from the single
3D input. The output directory must be new or empty. Progress goes to stderr;
stdout contains one JSON result. DICOM conversion and manual mask editing
remain web workflows.

Models are size- and SHA-256-verified on every load, including cache hits.
`NEURODESK_SEEDSEG_MODEL_DIR` or `--cache-dir` selects the model directory;
`NEURODESK_OFFLINE=1` or `--offline` refuses missing files. A corrupt file fails
without silently downloading a replacement. The source and browser adapters
also verify the QSM runtime and model pins respectively.

## Validation and limits

`validation/cli-check.mjs` runs the actual command and production browser
pipeline sequentially on the existing synthetic prostate fixture. It covers v2
network 1, the 5-network ensemble with changed K and threshold, and mirroring,
and v1 ensemble sizes 1–4 with top-1/top-2 selection and a changed threshold.
Marker masks must agree exactly; probability differences are reported without
inventing a new numerical tolerance (v2 network 1: at most 0.025 between ONNX
Runtime Node 1.29 and Web 1.21). The default four-model v1 result retains the
independent fixture gates: three components, centroids within one voxel of
planted seeds, at least 90% planted-voxel recall and at most ten times the
planted volume. The fixture is 1 mm isotropic and not N4-corrected, off v2's
training protocol (0.6875 x 0.6875 x 2 mm): v2 finds one planted seed with
network 1 and two with all five, so its gate is that every reported marker
lies within one voxel of a distinct planted seed and the count flag matches.
Dice against the planted voids is diagnostic, not an accuracy gate.

```sh
NEURODESK_SEEDSEG_MODEL_DIR=/path/to/models node packages/seedseg/validation/cli-check.mjs --composite
```

`--composite` requires a freshly assembled catalog; the default uses the fresh
standalone production app, as provisioned by portable CI. Browser development
dependencies stay outside the shipped archive. This is software and geometric
fixture validation, **not clinical accuracy validation**. A representative,
approved clinical scan and its reference remain pending. The app deliberately
has no public example; this fixture does not replace one.

Source code is MIT. Existing model licensing remains `NOASSERTION`; the command
line adds no new license claim. See `NOTICE` and the pinned manifests.

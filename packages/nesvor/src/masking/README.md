# MONAIfbs browser segmentation

`segmentStacks` ports NeSVoR v0.5.0's wrapper, including whole-stack normalization, eight test-time augmentations, align-corners bilinear interpolation, per-slice connected components and relative area rejection. It intersects the result with the existing stack mask. Inference uses one slice at a time to bound activation memory.

The checkpoint requires MONAI **0.3.0**. Newer versions changed DynUNet's module structure and normalization defaults. `prepare-monai.py` checks the original wheel's SHA-256 and replaces its obsolete Python import call; it does not change network code.

Keep downloads and exports outside this source repository. In an environment with PyTorch, NumPy, scikit-image, ONNX and ONNX Runtime installed:

```sh
python -m pip download --no-deps monai==0.3.0 -d "$TMPDIR/nesvor-monaifbs"
python packages/nesvor/src/masking/prepare-monai.py \
  "$TMPDIR/nesvor-monaifbs/monai-0.3.0-202010042353-py3-none-any.whl" \
  "$TMPDIR/nesvor-monaifbs/monai-source"
PYTHONPATH="$TMPDIR/nesvor-monaifbs/monai-source" python packages/nesvor/src/masking/export.py \
  --source "$TMPDIR/nesvor-source" \
  --checkpoint "$TMPDIR/nesvor-monaifbs/models/checkpoint_dynUnet_DiceXent.pt" \
  --output "$TMPDIR/nesvor-monaifbs/export"
node packages/nesvor/src/masking/verify-onnx.mjs "$TMPDIR/nesvor-monaifbs/export"
```

The published model is pinned by `manifest.json` to a Hugging Face commit. To verify hosted delivery, set `NESVOR_VERIFY_MODEL_URL` to the manifest's `base_url` when running `verify-onnx.mjs`. The browser downloads and checks the graph checksum before inference.

The checkpoint comes from the `models/checkpoint_dynUnet_DiceXent.pt` member of [the authors' archive](https://zenodo.org/records/4282679/files/models.tar.gz). Export produces checksummed metadata and compares real network logits against ONNX CPU. The browser script separately compares WebAssembly inference against those PyTorch logits. These are numerical implementation checks, not validation on fetal acquisitions.

Wrapper parity can be checked independently of learned weights:

```sh
python packages/nesvor/src/masking/export-wrapper-fixture.py \
  --source "$TMPDIR/nesvor-source" --output "$TMPDIR/monaifbs-wrapper.json"
node packages/nesvor/src/masking/compare-wrapper.mjs "$TMPDIR/monaifbs-wrapper.json"
```

The pinned upstream wrapper computes both padded dimensions from image height. Inputs for which this crops the width trigger a broken crop-back path upstream. This port rejects that case explicitly instead of returning an incorrectly shaped mask.

To compare masks on fetal tissue, `verify-stack.mjs` decodes a NIfTI stack through the application's shared decoder and selects three central slices. It runs the original eight-augmentation workflow in Chromium. Generate the independent reference using the original NeSVoR wrapper and checkpoint:

```sh
node packages/nesvor/src/masking/verify-stack.mjs \
  "$TMPDIR/nesvor-example/stacks/simulated-stack-d0.nii.gz" \
  "$TMPDIR/nesvor-monaifbs/export" --prepare
PYTHONPATH="$TMPDIR/nesvor-monaifbs/monai-source" python packages/nesvor/src/masking/export-stack.py \
  --source "$TMPDIR/nesvor-source" \
  --checkpoint "$TMPDIR/nesvor-monaifbs/models/checkpoint_dynUnet_DiceXent.pt" \
  --fixture "$TMPDIR/nesvor-monaifbs/export/stack.json"
node packages/nesvor/src/masking/verify-stack.mjs \
  "$TMPDIR/nesvor-example/stacks/simulated-stack-d0.nii.gz" \
  "$TMPDIR/nesvor-monaifbs/export"
```

The fixture is a subset of the pinned SVRTK simulated fetal example offered by the app. This comparison tests fetal-input masking, not complete acquisition reconstruction or clinical performance.

Verified on the first pinned SVRTK stack, slices 44–46: browser and original NeSVoR each produced 4,086 foreground voxels with zero voxel disagreements, Dice 1.0. All eight augmentations were enabled. The software-backed browser run took 108 seconds; this is not a hardware performance estimate.

## Browser acceleration

The reconstruction worker imports the WebGPU-capable ONNX runtime and requests
`executionProviders: ['webgpu']` for MONAIfbs. SVoRT still requests WASM.
The model weights, float32 inputs, eight augmentations and mask postprocessing
are unchanged. The compute log reports `Brain masking backend: webgpu` once
initialization finishes. The staged runtime includes the JSEP WASM module
required by ONNX WebGPU.

Use the same external export to compare providers against the upstream logits:

```sh
NESVOR_MASK_PROVIDER=wasm node packages/nesvor/src/masking/verify-onnx.mjs "$TMPDIR/nesvor-monaifbs/export"
NESVOR_MASK_PROVIDER=webgpu node packages/nesvor/src/masking/verify-onnx.mjs "$TMPDIR/nesvor-monaifbs/export"
```

Both scripts (`verify-onnx.mjs` and `verify-stack.mjs`) accept
`NESVOR_MASK_PROVIDER=wasm|webgpu`. GPU verification defaults to SwiftShader
for reproducibility on servers. Set `NESVOR_REQUIRE_HARDWARE=1` to use a real
adapter and reject software adapters. Report adapter details with timings;
software GPU timings are not hardware performance estimates. The logit test
includes first-inference compilation in its elapsed time. The stack test reports
successive slice-pass timings and checks the final eight-pass mask against
PyTorch with the existing Dice threshold of 0.999.

The production worker initialization and cancellation check uses the same pinned
model without committing it:

```sh
NESVOR_MASK_FIXTURE_DIR="$TMPDIR/nesvor-monaifbs/export" pnpm --filter nesvor test:e2e --grep 'production masking'
```

Verification on 2026-09-24 with Chromium SwiftShader:

- The 448 × 512 logit fixture passed the existing tolerance, with maximum
  absolute error 0.000084877 and zero argmax disagreements against PyTorch.
- The complete eight-pass, three-slice SVRTK fixture matched the PyTorch mask
  exactly: 4,086 foreground voxels, zero disagreements, Dice 1.0.
- Software WebGPU took 96.14 seconds for the cold logit fixture and 2,168.65
  seconds for the eight-pass mask; single-thread WASM took 4.77 seconds for
  the logit fixture. These results establish correctness, not a hardware
  speedup. Real GPU performance and full-acquisition validation remain unverified.
- SVoRT's two learned-step fixtures passed through the shared runtime with
  the WASM provider, without changing their numerical tolerances.
- The production browser test loaded the pinned model, reported the WebGPU
  backend, and cancelled the worker successfully.

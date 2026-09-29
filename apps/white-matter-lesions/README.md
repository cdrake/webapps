# White matter lesions

Segment white matter lesions on one FLAIR image, in the browser. Choose the multiple sclerosis
FLAIR from **Example**, or load one NIfTI image or DICOM series, and select **Segment lesions**.
The outputs are a lesion mask, a lesion probability map and a lesion table (TSV: voxels,
volume in ml and centroid in scanner coordinates, one row per 26-connected lesion). Every output
keeps the input grid and affine.

## Pipeline

1. SynthStrip (`@neurodesk/synthstrip`, the shared browser port) finds the brain. Tick
   *Image is already skull-stripped* in the advanced settings to use nonzero voxels instead.
2. `src/pipeline.js` repeats nnU-Net's inference for FLAMeS without reorienting: crop to the
   brain, z-score inside it, resample to 1 × 0.9 × 0.9 mm, run 112 × 128 × 160 patches at half
   overlap with Gaussian weighting, resample the lesion probability back and threshold at 0.5.
3. `src/worker.js` runs the network with ONNX Runtime Web, on WebGPU when the browser has an
   adapter and on WebAssembly threads otherwise.

The default model is FLAMeS fold 0. *Model* in the advanced settings switches to the published
five-fold ensemble, which runs the folds one after another over every patch and averages their
logits, so only one model is in memory at a time. All five are pinned in
`models/white-matter-lesions.manifest.json` and converted by `scripts/export_model.py`. The conversion is exact apart from storing weights as float16: each
transposed convolution becomes the equivalent 1 × 1 × 1 convolution plus depth-to-space, because
ONNX Runtime's WebGPU backend has no 3D transposed convolution.

On an 8-thread WebAssembly run the example takes about three minutes with one fold (one minute
of brain extraction and six patches of about 16 s) and about nine with the ensemble, whose first
run also downloads 310 MB instead of 62 MB.

## Why FLAMeS

`validation/README.md` compares the FLAIR-only candidates on 25 held-out scans of the MICCAI
2017 WMH challenge and the 22-patient MSLesSeg test split. FLAMeS was the only candidate that
did well on both vascular and MS lesions, needs only a FLAIR, has an open licence (CC BY 4.0)
and runs in a browser in minutes.

Differences from the published FLAMeS configuration, and what each costs on the WMH subset
(Dice): one fold instead of five (−0.037; −0.023 on MS), no mirroring, and trilinear rather than cubic
resampling (−0.018). SynthStrip with CSF, as shipped here, instead of `--no-csf` changed Dice by
+0.015.

## Development

```sh
pnpm --filter white-matter-lesions dev
pnpm --filter white-matter-lesions test
pnpm --filter white-matter-lesions test:e2e
node apps/white-matter-lesions/validation/parity.mjs <stripped FLAIR> <reference mask> <model.onnx>
```

The unit tests cover the pipeline arithmetic with literal values. The browser tests run the
hosted example and model end to end on WebAssembly, and check the model-download failure,
cancellation, example retry and settings persistence.

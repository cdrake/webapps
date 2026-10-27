---
"seedseg": minor
"@neurodesk/seedseg": minor
---

Merge upstream astewartau/prostate 3354f6c..c9b328a: SeedSeg v2.

- The default model is now upstream's nnU-Net v2 (residual encoder) network ensemble from 5-fold
  cross-validation, ported into the shared pipeline that the app and the `seedseg` command line
  both run: bias correction, crop to nonzero, z-score, resampling off the training spacing,
  Gaussian sliding window, optional test-time mirroring, the mean over the selected networks, and
  the K candidates with the highest mean probability, with a count flag when fewer are found.
- Network 1 of 5 runs by default; "Use all 5" selects the evaluated ensemble. Each network is
  downloaded from the pinned Hugging Face commit, checksummed, cached, and its ONNX session exists
  only while it runs (upstream's lazy sessions). The app tries WebGPU first and falls back to
  WebAssembly per network.
- Results list each marker's mean probability, volume and position; the marker mask holds the rank
  and can be edited. The previous 4-network 3D U-Net consensus stays available as the legacy v1
  model under Advanced, unchanged.
- Command line: `--folds`, `--mirror` and `--model v1` (with `--ensemble`/`--models`); v2 writes
  `probability.nii` and `markers.nii` and reports the detections on stdout. Portable releases bundle
  all nine models.
- Cite: nnU-Net and its residual-encoder configuration.

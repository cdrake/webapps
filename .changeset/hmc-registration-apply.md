---
"@neurodesk/hmc-registration": minor
---

Add ANTs `AverageImages` and `AverageAffineTransform`, and an antsApplyTransforms-style `--apply` with Linear, NearestNeighbor, BSpline, HammingWindowedSinc and LanczosWindowedSinc interpolation. `argv[0]` selects the program in `run(argv)` and in the worker. Each program writes the same bytes as native ANTs 52bc0ab on the test set. The `antsRegistration` output does not change.

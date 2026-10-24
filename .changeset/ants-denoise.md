---
"@neurodesk/ants-denoise": minor
---

Add `@neurodesk/ants-denoise`: ANTs `DenoiseImage` (adaptive non-local means, ITKAdaptiveDenoising) in its own WebAssembly module, with `createDenoiser` and the pinned Node loader `loadDenoise`. It runs one ITK thread, accepts an optional mask and returns float32 NIfTI.

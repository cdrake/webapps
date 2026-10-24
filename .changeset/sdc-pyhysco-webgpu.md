---
"@neurodesk/sdc": minor
"sdc": minor
"@neurodesk/runtime-support": patch
---

Run the PyHySCO Gauss-Newton evaluations and the preconditioned CG solves on WebGPU when the browser has a hardware adapter and JSPI. The CPU path stays the fallback. On ds005134 sub-01 the WebGPU field agrees with the native PyHySCO field to a median of 1.9e-5 Hz in the brain (#506).

The software-adapter check of `@neurodesk/runtime-support/mindgrab/backend` now also refuses WARP and adapters named `cpu`. The sdc WebGPU path and the hardware-GPU test helper use this one check.

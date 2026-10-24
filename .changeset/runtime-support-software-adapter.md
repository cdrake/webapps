---
"@neurodesk/runtime-support": patch
---

The software-adapter check of `mindgrab/backend` now also refuses WARP and adapters named `cpu`. The sdc WebGPU path and the hardware-GPU test helper use this one check.

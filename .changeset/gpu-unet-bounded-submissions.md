---
"@neurodesk/runtime-support": patch
"@neurodesk/synthseg": patch
"@neurodesk/synthsr": patch
"synthseg": patch
"synthsr": patch
---

Submit and await each WebGPU U-Net layer separately so a full-volume inference does not occupy one long command buffer. Preserve shader arithmetic and graph order, report the recorded device-loss reason instead of a generic readback failure, and check actual submission boundaries in SynthSeg's unchanged native-parity tests.

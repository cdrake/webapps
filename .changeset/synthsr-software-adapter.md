---
"fastprep": patch
"synthsr": patch
"@neurodesk/synthsr": patch
"@neurodesk/runtime-support": patch
---

SynthSR no longer runs on a software WebGPU adapter. fastprep chooses WebAssembly when the adapter is a fallback (SwiftShader on a VM or a hosted runner) or cannot bind the volume's largest buffer, and the SynthSR app starts on CPU there. The GPU buffer-limit message gives both sizes in MiB, so a need just above the limit no longer reads as "1.0 GiB but this device allows 1.0 GiB".

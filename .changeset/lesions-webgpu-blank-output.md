---
"white-matter-lesions": patch
---

Fall back to the CPU when WebGPU returns blank lesion scores. Some virtual GPUs, including GitHub's macOS runners, complete a WebGPU run but return all zeros, which reported no lesions. Non-finite or constant network output now counts as a WebGPU failure, so the segmentation restarts on WebAssembly.

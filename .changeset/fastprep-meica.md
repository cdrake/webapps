---
"fastprep": patch
"@neurodesk/fastprep": patch
---

Denoise runs with three or more echoes with ME-ICA (meica, a Rust port of tedana): components are classified on the motion- and distortion-corrected echoes and the rejected ones regressed from each preprocessed series (`desc-denoised`). The report adds a Multi-echo ICA section and runs the task GLM on both series. Adds a pinned multi-echo example.

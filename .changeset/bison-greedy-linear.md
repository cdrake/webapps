---
"bison": minor
"@neurodesk/bison": minor
"greedy": minor
"@neurodesk/hmc-registration": minor
---

BISON registers the T1 to the ICBM 2009c template (affine) and the FLAIR to the T1 (rigid) with Greedy instead of ANTs. On the five native validation subjects every label gate still holds and these two steps take about 30 s each instead of 94 and 130 s. The nonlinear registration stays on ANTs SyN. Greedy's WebAssembly gains a rigid (6 DOF) export and a browser worker for its single-threaded build, which BISON runs in the browser and in Node so that both give the same files. hmc-registration can write ITK `.mat` transforms (`writeMatTransform`).

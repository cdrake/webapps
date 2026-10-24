---
"degibbs": patch
"@neurodesk/degibbs": patch
---

The example is now the OpenNeuro ds005577 sub-107 AP slab (120 × 120 × 8 × 101, full Fourier, with its bval, bvec and sidecar), pinned to a Hugging Face commit. On it the port equals MRtrix 3.0.8 `mrdegibbs` to NRMSE 5e-20, and a new oracle test in `exes/dwi` holds it to NRMSE < 1e-15 in CI. The browser reference that the command line's release check uses is recorded again on this example.

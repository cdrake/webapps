---
"hmc": patch
"@neurodesk/hmc": patch
---

Refuse inputs the motion model cannot hold, with a clear message, instead of failing with "unreachable": a series is checked when it loads (decoded size and DWI volume count) and the GP brain mask and DWI count before the run; the command line checks before automatic masking. The limits are measured on the estimator's 1 GiB WebAssembly memory and shared with the `hmc` command line.

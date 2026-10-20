---
"sdc": minor
"@neurodesk/sdc": minor
---

SDC is a new app that estimates the susceptibility field of an EPI acquisition from two b = 0 images with opposite phase-encoding directions, such as AP and PA, in the browser. Drop the pair with its JSON sidecars (and a DWI series' bval), as NIfTI or DICOM; the app pairs them by `PhaseEncodingDirection`, averages each input's volumes with b ≤ 50 and runs PyHySCO with its command-line defaults in a Web Worker with a cancel. It writes the field in Hz with FSL topup's sign as `<stem>_fieldmap.nii.gz` with a sidecar (`Units: Hz`), and the two corrected b = 0 means for quality control. The method was chosen in the reverse-PE options document: it was the closest fast method to topup on six subjects.

`@neurodesk/sdc` holds the WebAssembly build of `exes/sdc`, a GPL-3.0-or-later Rust port of PyHySCO 0.0.4 that also builds the `sdc` command line. On ds005134 sub-01 the port equals a float64 PyHySCO run to 1e-14 from the same start, and the browser's field equals the command line's.

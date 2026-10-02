# @neurodesk/lcmodel

## 0.3.0

### Minor Changes

- e93c19a: GABA-edited MEGA-PRESS: FID-A's `run_megapressproc_auto` (coil combination, removal of bad averages, drift correction per subspectrum, alignment of edit-ON to edit-OFF; agrees with FID-A in GNU Octave to within 1e-7 Hz) and an LCModel fit of the difference spectrum with LCModel's MEGA-PRESS analysis (`sptype='mega-press-3'`). A new difference basis set (3 T, TE 68 ms) was simulated with FID-A's shaped 14 ms editing pulses, which reproduce the near-complete loss of the NAA singlet in the edit-ON scan that LCModel uses as its reference. The basis recommendation pairs edited data only with the difference basis and never offers it for unedited data. A Siemens MEGA-PRESS example (FID-A's, de-identified) gives GABA+/(NAA+NAAG) of 0.15 with 9 % SD; the edit-OFF spectrum is a separate download.

## 0.2.0

### Minor Changes

- bd01a6a: New app: LCModel preprocesses single-voxel MR spectroscopy with FID-A and fits it with LCModel, both as Rust ports compiled to WebAssembly. It reads Siemens twix, GE P-files, Siemens RDA and DICOM, Philips SPAR/SDAT, NIfTI-MRS, Bruker and LCModel .RAW files and pairs each spectrum with its water reference. FID-A's automatic pipelines combine coils, remove bad averages, correct drift by spectral registration and, for SPECIAL, combine the ISIS subspectra; they agree with FID-A in GNU Octave to within 10^-5 Hz. The LCModel port writes the same .TABLE and .COORD numbers as the Fortran on LCModel's test case. Nine basis sets simulated with FID-A (PRESS, STEAM, semi-LASER and SPECIAL at 1.5, 3 and 7 T) are offered; the app recommends the one that matches the data's field strength, sequence and echo time and explains any mismatch, or takes the user's own .BASIS file. Results are a fit plot, per-metabolite curves, the concentration table and downloads of the LCModel files.

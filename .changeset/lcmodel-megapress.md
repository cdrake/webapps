---
"lcmodel": minor
"@neurodesk/lcmodel": minor
---

GABA-edited MEGA-PRESS: FID-A's `run_megapressproc_auto` (coil combination, removal of bad averages, drift correction per subspectrum, alignment of edit-ON to edit-OFF; agrees with FID-A in GNU Octave to within 1e-7 Hz) and an LCModel fit of the difference spectrum with LCModel's MEGA-PRESS analysis (`sptype='mega-press-3'`). A new difference basis set (3 T, TE 68 ms) was simulated with FID-A's shaped 14 ms editing pulses, which reproduce the near-complete loss of the NAA singlet in the edit-ON scan that LCModel uses as its reference. The basis recommendation pairs edited data only with the difference basis and never offers it for unedited data. A Siemens MEGA-PRESS example (FID-A's, de-identified) gives GABA+/(NAA+NAAG) of 0.15 with 9 % SD; the edit-OFF spectrum is a separate download.

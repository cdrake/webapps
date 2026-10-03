# LCModel

Single-voxel MR spectroscopy in the browser: FID-A preprocessing and LCModel
fitting, both as Rust ports compiled to WebAssembly (`packages/lcmodel`).

* Input: Siemens twix, GE P-files, Siemens RDA and DICOM, Philips SPAR/SDAT,
  NIfTI-MRS, Bruker, or an already processed LCModel `.RAW` (with an optional
  `.H2O`, control file and `.BASIS`). Files are detected and paired with their
  water reference by `exes/fida/src/io/detect.rs`.
* Preprocessing: FID-A's `run_pressproc_auto` (PRESS/STEAM/semi-LASER; GE with
  `run_pressproc_GEauto`'s phasing) or `run_specialproc_auto` (SPECIAL).
  `run_megapressproc_auto` for GABA-edited MEGA-PRESS, whose difference
  spectrum LCModel fits with `sptype='mega-press-3'`. GE and Philips files do not
  record editing: `exes/fida/src/ops/editing.rs` detects edit-ON/OFF pairs from
  the data (NAA/Cr of alternate transients), and the user can override it. Coil-combined data are
  aligned and averaged only; `.RAW` goes straight to LCModel.
* Basis sets (`models/lcmodel.manifest.json`, built by `exes/lcmodel/basis/`):
  FID-A simulations with ideal pulses (PRESS at TE 30 to 144 ms, STEAM,
  semi-LASER and SPECIAL, at 1.5, 3 and 7 T), PRESS and semi-LASER sets with
  real refocusing pulse shapes across the voxel (`-shaped`), and MEGA-PRESS
  difference sets (3 T; TE 68 and 80 ms; TE 80 ms with macromolecule
  suppression), ranked for the data by `src/basis-select.js` from its field
  strength, sequence and echo time. A shaped set ranks above the ideal set with
  the same parameters; an MM-suppressed MEGA set ranks below the standard one,
  with a warning, because no header records the edit-OFF frequency. Users can
  drop their own `.BASIS` (plain or gzipped) in the basis section or with the
  data.
* GABA and co-edited macromolecules: MEGA-PRESS difference spectra are fitted
  from 4.2 to 0.5 ppm with two LCModel simulated components, MM09 (0.915 ppm)
  and MM3co (3.0 ppm, 14 Hz, 2 protons), tied by the soft constraint
  MM3co/MM09 = 1 ± 0.2 (Zöllner et al., NMR Biomed 2022;35:e4618, "MM09soft").
  The table reports GABA, MM3co and GABA+MM3co (GABA+), each with %SD. GABA+
  is robust; separating GABA from MM3co relies on the model's assumptions
  (MM3co line width, its ratio to MM09), and the split moves when they move.
  On the examples, relative to NAA+NAAG: Siemens GABA 0.067 (15 %), MM3co 0.220
  (10 %), GABA+ 0.287 (7 %); Philips GABA 0.131 (12 %), MM3co 0.165 (12 %),
  GABA+ 0.296 (6 %). GABA is 23 % and 44 % of GABA+, against the ~50 % usually
  assumed. GABA+ is higher than what a GABA-only fit (no MM model, 4.2 to
  1.95 ppm) reported (0.153 and 0.241, so 1.9 and 1.2 times): that fit leaves
  the broad co-edited signal at 3 ppm in the residual, as Zöllner et al. found. MM-suppressed sets
  get no MM3co.
* Output: fit, metabolite and preprocessing plots (`src/spectrum-plot.js`), the
  concentration table, and downloads of the concentrations (.csv), LCModel's
  `.table`/`.coord`, the `.RAW`/`.H2O`, the control file and FID-A's report.

Examples (Hugging Face `neurodeskorg/webapps`, `lcmodel/examples/`): FID-A's GE
PRESS phantom (3 T, TE 35 ms), FID-A's Siemens SPECIAL in vivo data (2.89 T,
TE 8.5 ms, 178 MB) and MEGA-PRESS data (TE 68 ms, 86 MB), headers de-identified,
Osprey's Philips MEGA-PRESS data (SDAT, TE 68 ms, MIT), and LCModel's synthetic test case,
whose table the app reproduces exactly (`e2e/smoke.spec.js`).

```bash
pnpm --filter lcmodel test        # basis selection, LCModel file parsing, plots
pnpm --filter lcmodel test:e2e    # browser workflow; LCMODEL_E2E_LARGE=1 adds SPECIAL and MEGA-PRESS
```

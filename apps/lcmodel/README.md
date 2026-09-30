# LCModel

Single-voxel MR spectroscopy in the browser: FID-A preprocessing and LCModel
fitting, both as Rust ports compiled to WebAssembly (`packages/lcmodel`).

* Input: Siemens twix, GE P-files, Siemens RDA and DICOM, Philips SPAR/SDAT,
  NIfTI-MRS, Bruker, or an already processed LCModel `.RAW` (with an optional
  `.H2O`, control file and `.BASIS`). Files are detected and paired with their
  water reference by `exes/fida/src/io/detect.rs`.
* Preprocessing: FID-A's `run_pressproc_auto` (PRESS/STEAM/semi-LASER; GE with
  `run_pressproc_GEauto`'s phasing) or `run_specialproc_auto` (SPECIAL).
  Coil-combined data are aligned and averaged only; `.RAW` goes straight to
  LCModel. Edited MEGA-PRESS is refused.
* Basis sets: nine FID-A simulations (PRESS, STEAM, semi-LASER, SPECIAL at 1.5,
  3 and 7 T) from `models/lcmodel.manifest.json`, ranked for the data by
  `src/basis-select.js` from its field strength, sequence and echo time.
  Users can supply their own `.BASIS`.
* Output: fit, metabolite and preprocessing plots (`src/spectrum-plot.js`), the
  concentration table, and downloads of the concentrations (.csv), LCModel's
  `.table`/`.coord`, the `.RAW`/`.H2O`, the control file and FID-A's report.

Examples (Hugging Face `neurodeskorg/webapps`, `lcmodel/examples/`): FID-A's GE
PRESS phantom (3 T, TE 35 ms), FID-A's Siemens SPECIAL in vivo data (2.89 T,
TE 8.5 ms, 178 MB, header de-identified) and LCModel's synthetic test case,
whose table the app reproduces exactly (`e2e/smoke.spec.js`).

```bash
pnpm --filter lcmodel test        # basis selection, LCModel file parsing, plots
pnpm --filter lcmodel test:e2e    # browser workflow; LCMODEL_E2E_LARGE=1 adds SPECIAL
```

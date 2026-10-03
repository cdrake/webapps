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
* Basis sets: fifteen FID-A simulations (PRESS at TE 30 to 144 ms, STEAM,
  semi-LASER and SPECIAL, at 1.5, 3 and 7 T) and a MEGA-PRESS difference set (3 T, TE 68 ms, shaped editing
  pulses) from `models/lcmodel.manifest.json`, ranked for the data by
  `src/basis-select.js` from its field strength, sequence and echo time.
  Users can drop their own `.BASIS` (plain or gzipped) in the basis section or
  with the data.
* Output: fit, metabolite and preprocessing plots (`src/spectrum-plot.js`), the
  concentration table, and downloads of the concentrations (.csv), LCModel's
  `.table`/`.coord`, the `.RAW`/`.H2O`, the control file and FID-A's report.

* Tissue correction (optional, `src/tissue-panel.js`): the voxel geometry comes
  from the header (`exes/fida/src/io/geometry.rs`: twix, Siemens DICOM, RDA,
  SPAR, NIfTI-MRS; spec2nii's conventions, checked against spec2nii). A T1 from
  the same session (NIfTI, or DICOM through the shared dcm2niix import) is
  segmented with MindMap's partial-volume maps (`@brainchop/mindgrab`
  `segmentTissues`; WebGPU, hardware WebGL2, else the threaded CPU module).
  `src/voxel.js` samples the oblique voxel box on the T1 grid (5 x 5 x 5 points
  per T1 voxel) for Osprey-style fractions; the Voxel view draws it on the T1.
  `src/tissue.js` is Osprey's `quantTiss`/`quantAlpha` (Gasparovic 2006, Harris
  2015) on LCModel's water-scaled output, tested against Osprey's own code in
  Octave. Fractions can also be typed in. GE, Bruker and .RAW carry no voxel
  position here.

Examples (Hugging Face `neurodeskorg/webapps`, `lcmodel/examples/`): FID-A's GE
PRESS phantom (3 T, TE 35 ms), FID-A's Siemens SPECIAL in vivo data (2.89 T,
TE 8.5 ms, 178 MB) and MEGA-PRESS data (TE 68 ms, 86 MB), headers de-identified,
Osprey's Philips MEGA-PRESS data (SDAT, TE 68 ms, MIT), Osprey's Philips PRESS
sub-01 (TE 35 ms) with its T1, defaced with the Deface app's
`niimath -deface avg152T1 avg152T1mask` (the published T1 has no face), and LCModel's synthetic test case,
whose table the app reproduces exactly (`e2e/smoke.spec.js`).

```bash
pnpm --filter lcmodel test        # basis selection, LCModel file parsing, plots
pnpm --filter lcmodel test:e2e    # browser workflow; LCMODEL_E2E_LARGE=1 adds SPECIAL and MEGA-PRESS
```

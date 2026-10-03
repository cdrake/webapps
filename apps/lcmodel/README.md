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
* Report: LCModel's PostScript page is not ported (`lps=0`); `src/report.js`
  writes a self-contained HTML report per fit instead (inline SVG plots, its own
  print CSS, no external resources): fit, concentration table with %SD above
  20 % marked, diagnostics, header, FID-A summary, basis set and checksum,
  control file and versions. View opens it in a tab for printing to PDF.
* Groups: several datasets (a folder of subjects; `detect.rs` pairs each
  spectrum with the water reference closest in the folder tree) are fitted one
  after the other by "Fit all N datasets". Basis per dataset (`planBases` in
  `src/group.js`): a dropped .BASIS fits all; a library set picked over the
  recommendation fits all if it suits all; otherwise each dataset gets its own
  recommendation. Failures and unreadable files become failed rows; the run
  continues. The group table (`src/group-view.js`) sits in the viewer's Group
  tab. The primary CSV is long (dataset x metabolite rows), because unit (mM or
  a.u.) and ratio reference (Cr+PCr, NAA+NAAG) can differ per dataset; a wide
  CSV and a zip of reports are also offered. Automation: `fit-group`.

Examples (Hugging Face `neurodeskorg/webapps`, `lcmodel/examples/`): FID-A's GE
PRESS phantom (3 T, TE 35 ms), FID-A's Siemens SPECIAL in vivo data (2.89 T,
TE 8.5 ms, 178 MB) and MEGA-PRESS data (TE 68 ms, 86 MB), headers de-identified,
Osprey's Philips MEGA-PRESS data (SDAT, TE 68 ms, MIT), Osprey's Philips PRESS
data of two subjects (TE 35 ms, MIT, the group example), and LCModel's synthetic test case,
whose table the app reproduces exactly (`e2e/smoke.spec.js`).

```bash
pnpm --filter lcmodel test        # basis selection, LCModel file parsing, plots, group table, report
pnpm --filter lcmodel test:e2e    # browser workflow; LCMODEL_E2E_LARGE=1 adds SPECIAL and MEGA-PRESS
```

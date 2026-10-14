---
"synthseg": minor
"@neurodesk/synthseg": minor
"@neurodesk/runtime-support": minor
"@neurodesk/webapp-components": minor
---

SynthSeg reports brain volumes against age. Segmentation now also returns the
soft-posterior volumes of FreeSurfer's `mri_synthseg --vol`, within 0.03 % of
FreeSurfer 8.2.0 on the T1 example in fast mode. A new Volumes view charts each
structure's head-size-adjusted volume against the IXI reference cohort's 5th–95th
and 25th–75th percentiles and median, with a table of volume, adjusted volume,
z, percentile and a flag below the 5th or above the 95th percentile. Age and sex
come from new Input fields, filled from the DICOM header when there is one. The
reference norms are fetched from the neurocontainers SynthSeg recipe at a pinned
commit and checked against their checksum. Research use only. Not for diagnostic
use.

- Fast mode is now the default processing mode in the app and the command line,
  because the norms were fitted on fast-mode volumes.
- The Output section adds Download volumes (.csv). The run report and automation
  measurements carry the volumes and the volume report, and `segment` accepts
  optional `age` and `sex` parameters.
- The `synthseg` command line writes `INPUT_synthseg_vol.csv` beside its other
  outputs. The native executable gains `--vol FILE.csv`.
- `@neurodesk/runtime-support` adds `readImageSeries`, which pairs each converted
  or supplied NIfTI with its BIDS sidecar.
- `@neurodesk/webapp-components` adds the `.nd-viewer-report` panel and the
  `.nd-chart` vocabulary for small-multiple SVG charts.

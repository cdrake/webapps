---
"synthseg": minor
"@neurodesk/synthseg": minor
---

SynthSeg exports GM, WM and CSF probability maps. Each map is the sum of the
normalized SynthSeg posteriors of a group of structures, on the label grid, as
float32 NIfTI. GM is cerebral and cerebellar cortex and the structures that
FreeSurfer's subcortical grey volume counts, ventral DC included. WM is cerebral
and cerebellar white matter and the brainstem. CSF is the ventricles and the CSF
label. The labels and the soft volumes do not change.

- The app's Output section adds GM, WM and CSF probability rows with View and
  Download. The run report and the automation `segment` operation list them as
  `gm`, `wm` and `csf` artifacts.
- The `synthseg` command line writes `INPUT_synthseg_gm.nii.gz`,
  `INPUT_synthseg_wm.nii.gz` and `INPUT_synthseg_csf.nii.gz` beside its other
  outputs, and its release check holds each map to its label map and volume
  table.
- The native executable gains `--tissues`, which writes `OUTPUT_gm`, `OUTPUT_wm`
  and `OUTPUT_csf` beside the label map.
- `runSynthseg` returns `tissues: { gm, wm, csf }`, and `@neurodesk/synthseg/results`
  adds `TISSUE_GROUPS` and `tissueVolumes`.

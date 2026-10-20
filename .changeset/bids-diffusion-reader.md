---
"@neurodesk/webapp-components": minor
---

`@neurodesk/webapp-components/file-io` reads diffusion inputs from a BIDS folder. `readBidsDiffusion(files)` takes the files of a folder input or a dropped folder (each with its `webkitRelativePath`) and returns one record per `dwi/*_dwi.nii[.gz]` run: its `.bval`, `.bvec` and JSON sidecar, merged by BIDS inheritance from the dataset root down; the `fmap/*_epi` images whose `IntendedFor` names it, as a `bids::` URI or a subject-relative path; and the subject's `anat/*_T1w` image, from the same session first. Sessions and several runs are supported, and the dataset may sit below the dropped folder. A run without a `.bval` or `.bvec` carries an `error` that names the missing file. Files the reader cannot pair are listed with the reason. Types are at `@neurodesk/webapp-components/file-io/bids`.

---
"spinalcordtoolbox": minor
"@neurodesk/spinalcordtoolbox": minor
---

Add `sct-webapp`, a portable command line for the app's SCT segmentation tasks.
The inference pipeline moves into `@neurodesk/spinalcordtoolbox`, shared by the
browser worker and the command line, so both write the same downloads. The
release bundles the spinalcord model; `sct-webapp download-models --task TASK`
fetches any other task's pinned model on first use. The web app now verifies
each model's size and SHA-256 when it downloads or reads it from its cache, and
no longer loads localforage from a CDN.

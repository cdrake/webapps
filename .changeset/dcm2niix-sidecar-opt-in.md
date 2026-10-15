---
"@neurodesk/runtime-support": patch
---

Allow callers of `runDcm2niix` to opt into non-anonymized BIDS sidecars with `anonymizeSidecar: false`, matching `readImageSeries`. The default retains dcm2niix's anonymization. Identifying sidecar fields stay in memory; SynthSeg automation uses them to select its population reference and fill omitted age and sex without saving the sidecar.

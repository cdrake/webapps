---
"qsmbly": patch
"@neurodesk/qsmbly": patch
---

Parse QSMxT TOML model settings and require the complete verified native weight registry before compute starts, preventing native downloads from mutable URLs. Both offline environment switches now reject incomplete model packs. Preserve explicit model-directory and offline settings in portable launchers, and permit first-use downloads for releases that do not bundle models.

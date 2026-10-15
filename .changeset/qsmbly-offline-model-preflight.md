---
"qsmbly": patch
"@neurodesk/qsmbly": patch
---

Require the complete verified native weight registry before every processing command, including QSMART, so native downloads from mutable URLs are unreachable. Both offline environment switches now reject incomplete model packs. Preserve explicit model-directory and offline settings in portable launchers, and permit first-use downloads for releases that do not bundle models.

Mirror all native examples to a commit-pinned dataset and use it for CLI downloads. Offline mode rejects example downloads; help and example listing remain available. Reject native SLURM generation and the TUI because their scheduler jobs bypass verified model preflight.

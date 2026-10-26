---
"pipeline-builder": patch
"@neurodesk/desktop": patch
---

Adopt NeuroFlow v0.2.1. Its `neuroflow-mcp` inspects FSL gradient tables, so generated tool inputs now declare `bval` and `bvec` formats again and the runtime rejects a swapped pair before launch. `bval-bvec`, which names a pair of files, has no inspector and stays only in `neurodesk/data`. The `neuroflow` CI job builds the v0.2.1 commit, and the docs point to the release's prebuilt binaries and their `SHA256SUMS`. Exported workflows need `neuroflow-mcp` 0.2.1 or later.

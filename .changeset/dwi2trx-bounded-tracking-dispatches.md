---
"dwi2trx": patch
---

Split GPU tracking into completed commands of at most 16 workgroups to avoid long generation commands triggering the GPU watchdog. Preserve logical seed batches, seed/lane indexing and Philox initialization; yield for cancellation between commands. Pin the patched GPUStreamlines source with its license and upstream hashes, and add hardware RNG equivalence and full real-data tracking regressions.

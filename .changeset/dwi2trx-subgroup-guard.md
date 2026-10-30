---
"dwi2trx": patch
---

Refuse streamline tracking on a GPU whose subgroups are not 32 lanes. The tracker's shader assumes 32-lane subgroups; on other sizes (some Intel and AMD GPUs) it computed wrong streamlines or lost the GPU device. The tracker now checks the adapter's subgroup range and the layout each kernel actually runs with, and stops with "tracking needs 32-lane GPU subgroups" instead. Output on 32-lane GPUs is unchanged.

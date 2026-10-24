---
"dwi2trx": patch
---

Fix TRX ZIP entry timestamps so identical scientific members produce identical archives across runs and time zones. Keep strict exported-workflow archive equality and save member hashes, headers and ZIP metadata when it fails.

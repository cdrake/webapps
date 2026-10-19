---
"dcm2niix": patch
---

Keep anatomical echo files attached to their converter acquisition when outputs are interleaved or an echo is excluded. Order runs by the converter's series number, preserve split acquisitions, and require echo time before exporting echo-labelled images. Refuse ambiguous duplicate echoes until acquisition labels distinguish them.

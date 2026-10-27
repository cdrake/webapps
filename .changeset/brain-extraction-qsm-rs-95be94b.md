---
"@neurodesk/brain-extraction": patch
---

Rebuild the BET kernel from QSM.rs 95be94b, the commit QSMbly's browser bundle now locks. BET's source is unchanged between the two commits and the mask on the test image is identical. The module is still 84,345 bytes but not byte-identical: its embedded source paths and its code layout differ.

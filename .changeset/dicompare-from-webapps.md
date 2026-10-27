---
"seedseg": patch
"qsmbly": patch
"dicompare": patch
---

Load the dicompare protocol checker, its worker and schemas from webapps.neurodesk.org/dicompare instead of dicompare.neurodesk.org, which no longer serves them. SeedSeg failed to start without it, and QSMbly's dicompare report was unavailable.

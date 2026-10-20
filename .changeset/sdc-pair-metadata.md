---
"sdc": patch
"@neurodesk/sdc": patch
---

SDC validates phase encoding and a finite positive TotalReadoutTime for both images, refusing unequal readouts because the current PyHySCO model assumes equal and opposite displacements. The command line keeps its explicit phase-direction flags and common --trt override. BIDS input uses the shared reader's IntendedFor associations to select one AP/PA fieldmap pair or a DWI with its reverse fieldmap, and refuses ambiguous pairs and unrelated subjects. Remove the unused app-config version placeholder so release metadata has one source.

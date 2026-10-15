---
"synthseg": minor
"@neurodesk/synthseg": minor
---

The brain volume report can compare against a 7 T reference. A new Reference field next to Age and Sex offers Auto (the default), IXI (1.5 T / 3 T) and AHEAD (7 T). Auto reads the scanner field strength from the DICOM header and uses AHEAD from 5 T upward, matching the neurocontainers SynthSeg container. Below 5 T, and for NIfTI input, which records no field strength, it uses IXI. Healthy 7 T scans score about +3.5 SD for cortical grey matter against IXI, so the reference matters.

The report names the reference with its field strength, says why it was chosen, and the saved run report records the reference id, choice and reason. Automation accepts a `reference` parameter (`auto`, `ixi` or `ahead`). Both norms files are pinned to neurocontainers commit c3e75dbe830b and checked against their SHA-256; the IXI models are unchanged.

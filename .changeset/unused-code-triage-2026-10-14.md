---
"ants": patch
"edgereg": patch
"greedy": patch
"calmar": patch
"dicom2vid": patch
"musclemap": patch
"spinalcordtoolbox": patch
"synthsr": patch
"vesselboost": patch
"@neurodesk/webapp-components": patch
"@neurodesk/synthsr": patch
---

Remove code that nothing calls, found by the unused-code report and checked by
repository-wide reference searches. The shared preview module no longer carries
a second NIfTI parser and writer; NiftiUtils remains the only one. Outputs and
behaviour are unchanged.

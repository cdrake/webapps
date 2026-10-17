---
"calmar": minor
"@neurodesk/calmar": minor
---

Segment acute stroke lesions on diffusion data. With DWI/TRACE and ADC, or DWI/TRACE and a b0 on the same grid, Run analysis seeds the lesion with DeepISLES SEALS (the ISLES'22-winning nnU-Net, fold 0, 59.5 MB) instead of the T1 model; without ADC it is computed from the b0. Diffusion-only input uses the DWI/TRACE for brain extraction and registration. The benchmark-only NVAUTO candidate is removed.

---
"calmar": minor
"@neurodesk/calmar": minor
---

Segment acute stroke lesions on diffusion data. With DWI/TRACE plus ADC or b0, Run analysis seeds the lesion with DeepISLES SEALS (the ISLES'22-winning nnU-Net, fold 0, 59.5 MB) instead of the T1 model; without ADC it is computed from the b0. Without a T1, the b0 or DWI/TRACE is used for brain extraction and registration. A new b0 input sits beside DWI/TRACE and ADC. The benchmark-only NVAUTO candidate is removed.

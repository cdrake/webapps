---
"@neurodesk/hmc-registration": patch
---

Reject malformed MATLAB transform headers before reading names or values, so invalid lengths and dimensions cannot stall the public reader. Preserve float and double transforms, including empty fixed-parameter matrices.

---
"white-matter-lesions": patch
"@neurodesk/webapp-components": patch
---

Read only the NIfTI header when loading a White matter lesions image, avoiding a full-image allocation just to display and check its dimensions.

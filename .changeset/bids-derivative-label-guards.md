---
"@neurodesk/webapp-components": patch
---

Reject missing, empty, or non-string step labels in `outputNames` and `derivativeSidecar` with a `TypeError`. Valid labels keep the same filenames and sidecar content.

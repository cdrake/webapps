---
"deface": patch
"@neurodesk/deface": patch
---

Let Deface archive validation use the launcher's bundled model directory instead
of supplying an empty temporary override. Source validation retains its temporary
template cache, and explicit model-directory overrides remain respected.

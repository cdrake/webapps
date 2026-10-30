---
"@neurodesk/bison": patch
"bison": patch
---

A registration group no longer loads a new kernel after 20 runs. The limit worked around #537, which the hmc kernel fixed by restoring its stack after each run. No group runs more than 19 commands, so every output stays the same. Each group still gets its own instance, and an abort still loads a new one.

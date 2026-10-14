---
"deface": patch
---

A failure while the page closes or reloads now appears in the status bar and
the technical log instead of being lost as an unhandled rejection. During
development, the reloaded module still waits for the previous one to release
its GPU device and workers.

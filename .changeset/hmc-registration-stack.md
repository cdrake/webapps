---
"@neurodesk/hmc-registration": patch
---

One kernel instance now serves many runs (200 in the tests): it no longer aborts on run 27 of NiFreeze's command lines (run 91 of the test pair). Emscripten's `callMain` left each run's argv on the 64 KiB stack; `run` now restores the stack pointer after each run (the rebuilt kernel exports `stackSave` and `stackRestore`) and gives `callMain` a copy of argv, which it changed. `main()` also registers ITK's IO factories once. The transforms are byte for byte the same, and the NiFreeze replay uses one instance for all 101 registrations.

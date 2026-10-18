---
"deface": patch
"browserqc": patch
"edgereg": patch
"greedy": patch
"ants": patch
"brain2print": patch
---

These apps no longer refuse to start in a browser without WebGPU. NiiVue falls back to WebGL2 when WebGPU is absent, and MindGrab falls back to WebGL2 or the threaded CPU, so the viewers, defacing, registration, brain extraction, quality control and meshing now run in browsers such as Firefox on Linux. When the browser offers neither WebGPU nor WebGL2, the app says that the image viewer cannot start.

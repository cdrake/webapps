---
"greedy": patch
"@neurodesk/greedy": patch
---

Fix the masked (`-gm`) NMI affine diverging on a whole-head T1 to template pair (#623). The fixed pyramid now applies Greedy's masked downsampling, so the masked objective matches Greedy's, and the command line starts from the physical identity unless `-ia-image-centers` is given, as Greedy does; the WebAssembly affine functions take that choice as an argument and the app wrappers keep starting from image centres.

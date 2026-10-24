---
"@neurodesk/ants-denoise": patch
"@neurodesk/bison": patch
"bison": patch
---

Keep repeated denoising calls stable by restoring the WebAssembly stack, and fix the pinned kernel rebuild. Reject invalid image geometry, accept DICOM series through the shared converter for T1 and FLAIR, and declare label maps and compressed outputs accurately. Keep both complete model workflows in the normal browser test tier. Public model publication remains required before the app can ship working examples.

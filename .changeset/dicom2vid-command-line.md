---
"dicom2vid": minor
"@neurodesk/dicom2vid": minor
---

Add the `dicom2vid` command line for Linux x64, Windows x64 and macOS on Apple
silicon. It reads NIfTI, MGZ and DICOM folders with the app's readers and
series selection, renders the app's frames and encodes them with libvpx VP9,
so its WebM matches the app's video in frame count, size, timing and key
frames. The app's pipeline moved into the shared `@neurodesk/dicom2vid`
package; its videos are byte-identical to before. The example volume now
carries its SHA-256 pin.

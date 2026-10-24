---
"@neurodesk/dwi2trx": minor
"@neurodesk/noddi": patch
"dwi2trx": patch
"noddi": patch
---

NODDI names the niimath build in its provenance when it fits the tensor with niimath dtifit, in the app and in the `noddi` command line. `@neurodesk/dwi2trx/niimath-version` gives the version of the pinned niimath build; DWI2TRX and the `dwi2trx` command line now read it from there.

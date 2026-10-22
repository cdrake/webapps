---
"@neurodesk/syncro": patch
---

Remove the unused `templateAsset` export from the SYNcro asset definitions (#256). The app has fetched the MNI152 template from the shared template catalogue since the image-pair change, so nothing imports it.

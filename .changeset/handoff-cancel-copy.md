---
"@neurodesk/webapp-components": patch
"white-matter-lesions": patch
---

`takeHandoff` takes a `signal`: an abort stops the copy out of storage instead of
letting it run on in the background, and rejects with the signal's reason. White
matter lesions passes its load job's signal, so the footer × ends the copy of an
image sent from another app. `copiesInPieces` is exported and pinned to the user
agents Playwright's engines report.

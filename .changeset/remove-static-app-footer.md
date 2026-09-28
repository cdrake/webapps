---
"calmar": patch
"musclemap": patch
"qsmbly": patch
"seedseg": patch
"spinalcordtoolbox": patch
"vesselboost": patch
"@neurodesk/webapp-components": patch
---

Remove the static bottom bar (version, privacy sentence, duplicate More Apps and GitHub links) from the six inference-workspace apps. The shared app bar already shows the version and links, and Privacy has its own dialog. The unused `.app-footer` and `.nd-app-footer` rules leave the shared stylesheets and the hosted theme.

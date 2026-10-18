---
"deface": patch
"browserqc": patch
"@neurodesk/browserqc": patch
"@neurodesk/webapp-components": patch
---

Deface and BrowserQC take the avg152 T1 2 mm template from the shared template
catalogue (`registry/templates.json`) and download it with `fetchTemplateFile`,
which checks its size and SHA-256 and caches it. Before, Deface fetched the template
and its face mask with no checksum; the face mask now goes through `fetchModel` with
its manifest checksum too. BrowserQC's air template, its manifest and Deface's
manifest name the catalogue URL, so the offline bundle carries one copy of the file
instead of three. BrowserQC cites the ICBM152 template paper. `fetchTemplateFile`
names the template when its bytes do not match the pin.

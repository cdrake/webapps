---
"@neurodesk/hmc": patch
---

Release copied text and transform result buffers with the NiFreeze model so repeated full-volume GP runs can reuse the bounded WebAssembly heap without fragmentation. Preserve all scientific output values and the production heap limit.

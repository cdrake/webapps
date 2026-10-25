---
"spinalcordtoolbox": patch
---

Retry transient downloads while staging pinned browser-analysis runtime assets, with bounded attempts and unchanged size and SHA-256 checks. Do not publish failed or corrupt downloads into the runtime cache.

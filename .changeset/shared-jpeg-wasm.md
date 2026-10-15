---
---

Composite builds share one checksum-pinned JPEG DICOM WASM instead of keeping
21 identical app copies, removing 18,000,060 bytes of duplicate WASM. Rewriting
handles relative and root-relative worker URLs while keeping worker scripts and
threaded runtimes inside each app's service-worker scope. The artifact budget
remains unchanged.

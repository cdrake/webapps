---
"synthsr": patch
---

SynthSR builds with npm 12. Its standalone package step read `npm pack --json` as an array, which npm 11 prints; npm 12 prints an object keyed by package name, and the build stopped with "object is not iterable". The step now reads both.

---
"noddi": minor
"@neurodesk/runtime-support": minor
---

NODDI now extracts a MindGrab brain mask from the mean b0 before fitting when no mask is supplied. The shared MindGrab runtime exposes brain-mask extraction with its existing backend selection and cancellation support. The app stages the pinned model runtimes locally for offline use; a supplied mask still bypasses extraction.

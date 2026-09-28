---
"synthseg": patch
---

One click on the labels Download button saved the file twice: the result list's download callback and a second `saveBtn.onclick` handler both fired. The button now downloads once, and batch jobs no longer fail with "Duplicate output".

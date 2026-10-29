---
"pipeline-builder": patch
---

Store array parameters such as QSMbly echo times, Easy MP2RAGE acquisition values and SeedSeg folds and models as typed JSON arrays. Their fields accept a JSON array or comma-separated values, check each value against the declared item type, range and choices, and show an error in place without changing the saved value. Number fields also reject text, fractional integers and values outside their range. Validation reports an imported constant that does not match its parameter type, which the NeuroFlow core does not check.

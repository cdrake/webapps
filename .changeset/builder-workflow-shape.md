---
"pipeline-builder": patch
---

Refuse an imported workflow whose steps, bindings, inputs or outputs are not objects, instead of opening it and breaking every later edit until New. Report a reference to an undeclared workflow input as an error, which the NeuroFlow core does not check. A builder check that fails no longer hides the core's own issues.

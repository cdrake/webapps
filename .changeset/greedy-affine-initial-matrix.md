---
"greedy": minor
---

`greedy-rs -a` accepts Greedy's `-ia FILE` (start from an affine matrix) and `-ia-identity`; `register_affine_masked_wasm` takes the matrix text as an optional last argument. Starting a masked (`-gm`) NMI affine from the unmasked affine converges on BISON T1s where the identity start still collapses (#623).

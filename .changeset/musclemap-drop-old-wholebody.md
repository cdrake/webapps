---
"musclemap": patch
"@neurodesk/musclemap": patch
---

The offline bundle no longer downloads the retired compressed whole-body v1.3
model, which no MuscleMap version loads. The unused `MODEL_BASE_URL` export
is removed from the generated model catalog.

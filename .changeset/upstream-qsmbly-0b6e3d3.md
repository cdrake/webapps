---
"qsmbly": patch
---

Merge upstream astewartau/qsmbly cf88ee3..0b6e3d3:

- Run worker: a run that dies in the engine says why, not "attempted to take ownership" (#177)
- CI: reuse the deploy bundle when its inputs are unchanged, and keep its compiled dependencies (#176)
- Repin qsmxt-engine: SynthSeg runs in windows in the browser, so segmentation fits the heap (#178)
- CI: parity with qsmxt run — every option without running, and a tiny phantom end to end (3.7) (#179)
- next.html: SWI/SMWI and relaxometry shown as what they are — colormaps and windows per output, wiring tests
- next.html: R2′ and the settings the engine turns on — pin QSMxT main e426923
- next.html: segmentation, region referencing and the per-structure statistics table
- next.html: motion correction — the motion report per echo, wiring tests
- next.html: χ-separation, classical and deep-learning, at patches that fit the heap
- next.html: real and imaginary parts (GE's phase sign), uncombined coils and a MESE for R2
- Model weights: a file too big to cache no longer hangs the download
- Redesign plan: U8 status, open items after it, and the switch checklist
- Merge pull request #181 from astewartau/next-swi-relax
- Merge pull request #182 from astewartau/next-seg-stats
- Merge pull request #183 from astewartau/next-motion
- Merge pull request #184 from astewartau/next-input-types
- Merge pull request #185 from astewartau/next-chisep
- Pipeline tab live during a run (parity plan G5) (#188)
- next.html: QSMART's BET mask from the engine, and a chosen threshold kept — pin QSMxT #405
- Repin qsmxt-engine to QSMxT main 837cb25
- Merge pull request #187 from astewartau/next-qsmart-mask
- next.html: each step's memory in the plan drawer and pipeline, and a run the heap may not hold says which step (E3) (#189)
- Repin qsmxt-engine to QSMxT main 36f1492 (#190)
- Repin qsmxt-engine to QSMxT main 49b6f2d (#191)
- Repin qsmxt-engine to QSMxT 1f72772: TFI MERIT and QSMART's SDF spatial radius removed (#192)

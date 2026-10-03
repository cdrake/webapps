---
"lcmodel": minor
---

Separate GABA from co-edited macromolecules in MEGA-PRESS fits, and add basis sets. The fit now models the macromolecule signal at 3.0 ppm (MM3co) that GABA editing co-edits, tied to the macromolecule peak at 0.915 ppm as Zöllner et al. (2022) recommend, and reports GABA, MM3co and GABA+ with %SD; edited data are fitted from 4.2 to 0.5 ppm. GABA+ is the robust number: the split rests on the model's assumptions. New basis sets: MEGA-PRESS at TE 80 ms, with and without macromolecule suppression (edit-OFF at 1.5 ppm), and PRESS and semi-LASER sets simulated with real refocusing pulse shapes across the voxel, which the app now prefers to the ideal-pulse set with the same parameters.

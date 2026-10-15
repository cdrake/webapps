---
"lcmodel": patch
"@neurodesk/lcmodel": patch
---

A Siemens session folder that holds the averaged (`_ave`) and unaveraged series of one acquisition beside its water-unsuppressed (`_water_off`) series now pairs that water reference with both spectra. Before, the second spectrum stopped the folder pairing, so the spectrum was fitted without water and the water series was listed as unpaired. The water series pairs only with spectra of the same study and protocol (series description without the series number and suffix).

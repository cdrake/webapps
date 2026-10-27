---
"qsmbly": patch
---

Merge upstream astewartau/qsmbly cf88ee3..0b6e3d3, with qsmxt-engine at QSMxT 1f72772 and QSM.rs 95be94b:

- A run that dies inside the engine reports the panic's message instead of "attempted to take ownership of Rust value while it was borrowed".
- SynthSeg segmentation runs in sliding windows, and BFRnet, iQFM, iQSM and iQSM+ run tiled with the deep-learning tiling setting, so they fit the browser's WASM heap.
- QSMART's BET mask is applied as a normalisation rule and a threshold you chose is kept.
- MEDI filters the dipole kernel with the SMV kernel's k-space response; χ-separation (MEDI) weights the R2′ term as Shin et al. 2021 do and its TV weights default to 30 instead of 1000, so χ+ and χ− now separate instead of both following R2′; AutoQSM negates the field into the network's training convention; TGV's oblique stencil uses a fast DST-I (about 10× faster).
- χ-sepnet runs in a 192×192×128 sliding-window patch.
- TFI's MERIT switch and QSMART's SDF spatial radius are removed: both had no effect on the result.
- The default real-brain reconstruction (ROMEO, V-SHARP, RTS) is unchanged: its recorded χ map and mask are identical to the previous release's.

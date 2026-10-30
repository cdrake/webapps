---
"brainqcnet": minor
---

Add BrainQCNet, an app that checks a T1-weighted MRI for motion and other artifacts in the browser. It classifies every x, y and z slice with the authors' ResNet152 ProtoPNet through ONNX Runtime Web (WebGPU when available, otherwise WebAssembly), reports whether the image shows artifacts and the share of slices flagged, and downloads the BIDS app's table.csv, tot_df.csv and per-axis local results with a map of the flagged slices. The method and the number of areas per axis are the BIDS app's `--pred_method` and `--n_areas`. On the two MR-ART examples, a still scan and one with deliberate head motion, the tables equal those of the original `garciaml/brainqcnetcpu` container byte for byte, apart from the processing time.

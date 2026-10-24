---
"bison": minor
"@neurodesk/bison": minor
---

Add BISON, brain tissue segmentation in the browser. From a T1-weighted image it classifies 8 tissue classes; with a FLAIR image, BISON-WMH adds white matter hyperintensities. `@neurodesk/bison` holds the pipeline that the app and the Node command line share: ANTs denoising, N4, registration to ICBM 2009c, the random forest features and the outputs on the T1 grid. The trained classifiers and priors are not published yet, so a run needs a local copy of them until the BISON authors allow publication.

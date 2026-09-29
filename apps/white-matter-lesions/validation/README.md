# Choosing a FLAIR lesion segmentation method for the browser

The app needs a method that works from a FLAIR image alone, on both vascular white matter
hyperintensities and multiple sclerosis lesions, with weights we may redistribute, and that runs
in a browser tab in minutes. This directory holds the comparison that picked FLAMeS and the
checks that the browser port reproduces it. Measured 2026-09-29.

## Candidates

| Method | Input | Weights and licence | Browser fit |
| --- | --- | --- | --- |
| [FLAMeS](https://doi.org/10.5281/zenodo.17955359) (nnU-Net, 2025) | FLAIR, skull-stripped | 5 folds, 31 M parameters each; CC BY 4.0 on Zenodo v2 (its Hugging Face copy says CC BY-NC 4.0; the app uses the Zenodo release) | 3D patches; 62 MB per fold as float16 |
| [MindGlide](https://github.com/MS-PINPOINT/mindGlide) (MONAI DynUNet, 2025) | any contrast, no preprocessing | 123 MB; MIT | 3D patches |
| [sysu_media](https://github.com/hongweilibran/wmh_ibbmTum) (MICCAI 2017 winner) | FLAIR, or FLAIR + T1 | 3 × 35 MB 2D U-Nets; GPL-3.0 | 2D slices; fixed intensity threshold for the brain mask |
| [WMH-SynthSeg](https://github.com/freesurfer/freesurfer/tree/dev/mri_WMHsynthseg) (FreeSurfer, 2024) | any contrast | 790 MB checkpoint; FreeSurfer licence | whole 1 mm volume at once |
| [LST-AI](https://github.com/CompImg/LST-AI) (2024) | FLAIR **and** T1 | MIT | excluded: needs a T1 |
| LST-LPA (SPM toolbox) | FLAIR | SPM/MATLAB | excluded: no open runtime to port |

## Data

- **WMH**: 25 scans of the MICCAI 2017 WMH challenge test set, five per scanner group
  (Amsterdam GE 1.5 T, GE 3 T and Philips, Singapore, Utrecht), drawn with `random.seed(0)`.
  Label 2 (other pathology) is excluded from scoring. The data are CC BY-NC 4.0; the Hugging Face
  mirror `MedOtter/wmh-segmentation` labels them CC BY 4.0, which is wrong, so they are used for
  scoring only. sysu_media was trained on this challenge's training scans from three of these
  groups, so its WMH scores are in-domain.
- **MS**: the 22 patients of the MSLesSeg test split
  ([doi:10.6084/m9.figshare.27919209](https://doi.org/10.6084/m9.figshare.27919209), CC BY 4.0),
  1 mm MNI space, already skull-stripped.

Scores are the WMH challenge's voxel Dice, absolute volume difference (AVD, %) and 26-connected
lesion recall and F1. FLAMeS inputs were skull-stripped with SynthStrip 1.6 (`--no-csf` unless
stated). CPU times are on a shared 16-core virtual machine and only indicative.

## Results

Mean over cases. Dice, AVD %, lesion recall, lesion F1.

| Method | WMH (n = 25) | MS (n = 22) |
| --- | --- | --- |
| sysu_media, FLAIR only | **0.760**, 46.3, 0.902, 0.638 | 0.549, 44.1, 0.699, 0.450 |
| FLAMeS, 5 folds (nnU-Net, no mirroring) | 0.714, 53.8, 0.725, **0.750** | **0.648**, 44.1, 0.777, **0.716** |
| FLAMeS fold 0, cubic resampling | 0.695, 51.1, 0.690, 0.715 | 0.623, 41.8, 0.768, 0.687 |
| **FLAMeS fold 0 as shipped** (SynthStrip with CSF) | 0.692, 48.3, 0.639, 0.693 | — |
| FLAMeS fold 0, trilinear (`reference.py`) | 0.677, 60.0, 0.720, 0.714 | 0.625, 38.5, 0.759, 0.681 |
| MindGlide | 0.569, 132.8, 0.559, 0.509 | 0.338, 381.7, 0.661, 0.366 |
| WMH-SynthSeg | not completed: 26 GB resident and 32 min into the first scan | — |

The MS inputs are skull-stripped, so the app's *already skull-stripped* path applies and the
shipped configuration equals the trilinear row there.

What decided it:

- sysu_media leads on WMH, but it was trained on those sites, and on MS lesions it falls to Dice
  0.55 and lesion F1 0.45. It is 2D, masks the brain with a raw-intensity threshold of 30 that
  depends on scanner scaling, and its weights are GPL-3.0.
- FLAMeS is second on WMH at the voxel level, first on lesion F1, and first on MS. It needs only a
  FLAIR, the shared SynthStrip port supplies the skull stripping, and its licence allows
  redistribution.
- MindGlide over-segments both cohorts (AVD 133 % and 382 %).
- WMH-SynthSeg processes the whole 1 mm volume with 64 base features. On this machine one scan
  exceeded 26 GB of memory, far beyond a browser tab. Published comparisons also place its Dice
  well below dedicated FLAIR models ([segcsvd](https://doi.org/10.1002/hbm.70104)).

Browser-configuration choices: one fold instead of five costs 0.037 Dice on WMH and 0.023 on MS, and
runs five times faster with a fifth of the download. Cubic resampling gains 0.018 on WMH but
nothing on MS (−0.002), so the port keeps trilinear. Float16 weight storage changes no score at
three decimals. SynthStrip with CSF, which the repository already ships, scores 0.015 higher than
`--no-csf`, with lower lesion recall.

## Port checks

- `parity.mjs` runs `src/pipeline.js` with ONNX Runtime Web (WebAssembly) against
  `reference.py` on the same skull-stripped input and model. Utrecht 9: Dice 0.998, 59 of about
  16 400 lesion voxels differ, from float rounding between runtimes.
- The exported graph matches the PyTorch checkpoint in ONNX Runtime; the transposed-convolution
  rewrite changes no output (max difference 0). On WebGPU (Chromium, SwiftShader) a 32 × 64 × 64
  export of the same graph agreed with native ONNX Runtime to 2 × 10⁻⁴ in the logits and on every
  voxel's class. SwiftShader is software rendering, so it gives no GPU timing.
- The shipped example (MSLesSeg P57, clinical 2.3 mm FLAIR) runs in the built app in about three
  minutes on eight WebAssembly threads: 60 lesions, 30.9 ml. The expert mask for that patient,
  in MNI space, holds 42.1 ml.

## Reproduce

```sh
# work directory holding the data, the exported folds (flames_f0.onnx …) and out/
python score.py wmh <work> <method>...
python score.py ms <work> <method>...
python reference.py <work> flames_f0 --inputs stripped --folds 0 --order 1
node parity.mjs <work>/stripped/Utrecht_9.nii.gz <work>/out/flames_f0/Utrecht_9.nii.gz flames-fold0.onnx
```

`subset.json` lists the WMH cases and `results.json` holds every per-case score above. The other
candidates ran through their own tools:
`nnUNetv2_predict -d 4 -c 3d_fullres -tr nnUNetTrainer_8000epochs -f 0 1 2 3 4 --disable_tta`
for FLAMeS, `mindglide -i in/ -o out/mindglide/`, and sysu_media's `test_tf2.py` functions with
`two_modalities = False`.

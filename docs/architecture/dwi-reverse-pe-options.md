# Reverse phase-encoding distortion correction: options

Decision document for [#471](https://github.com/neurodesk/webapps/issues/471), 19 October 2026.
The app that follows from it is [#473](https://github.com/neurodesk/webapps/issues/473).

## Question

A dataset can have b0 images with opposite phase-encoding (PE) directions, for example AP and PA.
A reverse-PE method calculates the susceptibility field from such a pair.
FSL `topup` is the usual tool, but its licence does not permit a port.
This document finds a method that we can port into the `sdc` app.

Synb0-DisCo is not an alternative to this method.
It makes a synthetic undistorted b0 from a T1w image and then needs a reverse-PE solver: it runs `topup` with the synthetic image as the second image (`acqparams` row `0 1 0 0.000`).
Its `--notopup` option stops before that step, so it can supply the solver that this document chooses.
Thus the solver comes first and Synb0-DisCo is a later front end.

## Recommendation

RESULTS PENDING.

## Candidates

| Candidate | Source, version | Licence (file) | Conclusion | Status here |
| --- | --- | --- | --- | --- |
| FSL `topup` | FSL 6.0.7.23 | FSL licence | no port; reference tool only | run (reference) |
| ANTs SyN, restricted to the PE axis | ANTs 2.6.5 (native), commit `52bc0ab` 2.6.2 (WebAssembly) | Apache-2.0 (`COPYING.txt`) | port | run |
| PyHySCO | [EmoryMLIP/PyHySCO](https://github.com/EmoryMLIP/PyHySCO) `bff6655`, PyPI 0.0.4 | GPL-3.0 (`LICENSE`) | port into a GPL-3.0 package | run |
| AFNI `3dQwarp -plusminus` | AFNI 26.3.04, [afni/afni](https://github.com/afni/afni) `1dc9b75` | public domain (`LICENSE.txt`), CC-BY-4.0 for MCW parts since 12 May 2026 (`doc/README/README.copyright`) | port possible, large | run |
| TORTOISE DR-BUDDI | [QMICodeBase/TORTOISEV4](https://github.com/QMICodeBase/TORTOISEV4) `1ffb8f3`, 4.1.0, in QSIPrep 26.1.1 | GPL-3.0 (`LICENSE`); the repository also has a prebuilt BET-derived library (`external_libraries/bet/`) | port the solver only, never the bundled library; large | run |
| FD-Net | [icon-lab/FD-Net](https://github.com/icon-lab/FD-Net) `2f5c37e` | MIT (`LICENSE`) for code and weights; the weights come from HCP data, whose data-use terms must allow publication | ship only after the HCP terms are checked | run |
| Clean-room topup | Andersson, Skare and Ashburner 2003 | re-implementation from the paper | large separate project | not run |
| ACID HySCO | [ACID](https://bitbucket.org/siawoosh/acid-artefact-correction-in-diffusion-mri) `2eaff7c` | GPL-2.0-or-later (`README.txt`; the `LICENCE.txt` it names is missing at that commit) | PyHySCO is the same model | not run: needs a MATLAB licence |
| S-Net, TS-Net | [soanduong/S-Net-and-TS-Net-pytorch](https://github.com/soanduong/S-Net-and-TS-Net-pytorch) `c7a92cd` | MIT | no trained weights published | not run |
| sudistoc | [CIG-UCL/sudistoc](https://github.com/CIG-UCL/sudistoc) `90e5109` | Apache-2.0 | no trained weights published | not run |
| DrC-Net | [YuchuanQiao/DrC-Net](https://github.com/YuchuanQiao/DrC-Net) `e973e9e` | Apache-2.0, with a vendored GPL-3.0 `neuron/` | its input is FOD images, not b0 | not run |
| EPIC | [dominicholland/EPIC](https://github.com/dominicholland/EPIC) `f6bfa4a` | no licence ("Copyright 2010 Holland and Dale") | cannot port | not run |
| ANIMA distortion correction | [Inria-Empenn/Anima-Public](https://github.com/Inria-Empenn/Anima-Public) `d9fb323` | AGPL-3.0-or-later | below topup in Gu and Eklund 2019 | not run |

The licence policy for this work: GPL-3.0-compatible sources may be ported into a separate solver package.
The app that bundles that package is then distributed under GPL-3.0.
The SyN-SDC code stays Apache-2.0.

## Models and porting cost

| Candidate | Field model | Jacobian modulation | Images per PE direction | Field output | Code a port needs |
| --- | --- | --- | --- | --- | --- |
| `topup` | B-spline (cubic), movement model | yes | many | Hz (`--fout`), B-spline coefficients | not portable |
| ANTs SyN, restricted | SyN velocity field, Gaussian regularized | no | one (mean) | displacement field (mm) | reuses the `run(argv)` module of #444 and #462 |
| PyHySCO | 1D field per PE column, staggered grid, hyperelastic regularizer, Gauss-Newton with preconditioned CG | yes | one (mean) | displacement (mm) | Python/PyTorch, about 2.5k lines (`src/EPI_MRI`, `src/optimization`) |
| `3dQwarp -plusminus` | composed local patch warps (cubic/quintic Hermite) | no | one (mean) | half-warps to the midpoint (mm) | C with OpenMP: `3dQwarp.c` 4,152 lines, `mri_nwarp.c` 13,001, `thd_incorrelate.c` 2,069, plus AFNI's `mrilib` and a NEWUOA optimizer |
| DR-BUDDI | symmetric diffeomorphic, restricted to the PE axis, up and down fields opposite | yes | one per side (QSIPrep gives the mean) | ITK displacement fields (mm) | C++ on ITK 5/6 and Boost, optional CUDA: about 5.5k lines of `DRBUDDI*` plus about 80 KB of metric headers |
| FD-Net | 2D U-Net per axial slice, forward-distortion model with a sinc K-unit | yes | one per side | displacement (voxels) | TensorFlow 2.10, about 5M parameters, 21 MB weights; ONNX export needed |

## Published accuracy

- Gu and Eklund 2019 ([doi:10.3389/fninf.2019.00076](https://doi.org/10.3389/fninf.2019.00076)) compared reverse-PE methods on simulated HCP data.
  DR-BUDDI and topup were the best.
  b0 mean absolute error (LR): DR-BUDDI 2.58, HySCO 2.68, EPIC 3.20, topup 3.50.
  FA mean absolute error (LR, x 10⁻²): DR-BUDDI 1.70, topup 1.92, EPIC 3.14, HySCO 3.33.
  It did not test 3dQwarp or learned methods.
- Julian and Ruthotto 2024 (PyHySCO, [arXiv 2403.10706](https://arxiv.org/abs/2403.10706), Table 6), HCP 3T, n = 20.
  Relative improvement in image distance: PyHySCO 82.7 %, HySCO 79.0 %, topup 54.4 %.
  The metric is PyHySCO's own objective, so it favours PyHySCO.
- Zaid Alkilani et al. 2023 (FD-Net, [doi:10.1002/mrm.29851](https://doi.org/10.1002/mrm.29851)): "competitive with topup" on HCP test subjects, which are the same scanner and protocol as its training data.
- We found no published comparison of `3dQwarp -plusminus` with topup.
  Current sdcflows has a tested `init_3dQwarp_wf`, but it connects only `init_topup_wf` in production.
- We found no published blip-up/down method that uses ANTs SyN alone.
  DR-BUDDI is, in effect, the purpose-built version of that idea.

## Measurement

### Data

| Dataset | Subjects | AP b0 | PA b0 | T1w | Other |
| --- | --- | --- | --- | --- | --- |
| [ds005134](https://openneuro.org/datasets/ds005134) 1.0.0 (`34e971d`) | sub-01 | 13, in the DWI series | 8, `fmap/*_epi` | MPRAGE 0.8 mm | GRE field map (phasediff, ΔTE 2.46 ms) |
| [ds004146](https://openneuro.org/datasets/ds004146) 1.0.4 (`a0844ee`) | sub-0001 to sub-0005 | 3, in the ses-01 run-01 AP DWI series | 3, in the ses-01 run-01 PA DWI series | MP2RAGE UNIT1 (denoised) | |

ds005134 is a Siemens Skyra 3T, 2 mm, 116 x 116 x 69, TotalReadoutTime 0.038 s.
ds004146 is a Siemens Prisma fit 3T, 2 mm, 122 x 122 x 68, TotalReadoutTime 0.035 s.
Together they test both input forms that the app must read: reverse-PE b0 in `fmap/*_epi`, and b0 inside a reverse-PE DWI series.
`fetch.sh` takes each file from the public OpenNeuro bucket and checks it against the annex key in the git tree at the pinned tag.

### Preparation

`prep.sh` does this for each subject:

1. Take the volumes with b ≤ 50 from each direction.
   Crop both series to an even number of slices, because `b02b0.cnf` subsamples by 2 (ds005134 goes from 69 to 68 slices).
2. Align each direction's b0 volumes to its first volume (`mcflirt -refvol 0`) and average them.
   The first AP b0 is topup's reference frame, so every field lives on that grid.
3. Align the PA mean to the AP mean rigidly with ANTs (the sdcflows PEPOLAR setup).
4. T1w: MindGrab brain mask, FSL FAST white matter for the BBR cost.

topup gets all b0 volumes, as the protocol decided.
Every other method gets the same mean AP and aligned mean PA pair.

### Methods as run

| Method | Command (see `methods.sh`) |
| --- | --- |
| `topup` | `topup --config=b02b0.cnf --nthr=8` on all b0 volumes; `topup-single` on the first AP and the first PA b0 only |
| ANTs | `antsRegistration` SyN, PA onto AP, `--restrict-deformation` on the PE axis, CC radius 4, the SyN-SDC schedule (`SyN[0.8,6.0,10.0]` 200x100 then `SyN[0.8,2.0,0.5]` 10); field = half the displacement |
| PyHySCO | its command-line defaults (Gauss-Newton, Jacobi-PCG, α 300, β 10⁻⁴, 50 iterations, single precision); CPU with 8 threads, and once on the GPU |
| 3dQwarp | `-plusminus -blur -1 -1 -minpatch 9 -noweight -pblur 0.05 0.05 -nopadWARP -noXdis -noZdis` (sdcflows) |
| DR-BUDDI | the TORTOISE `DRBUDDI` binary from QSIPrep 26.1.1, b0 only, inputs written as QSIPrep's `GatherDRBUDDIInputs` writes them (LPS, float32, dummy `.bmtxt`) |
| FD-Net | the 42-subject DWI weights, each axial slice with the PE axis first, zero-padded to 144 x 168 |

### One field convention and one resampler

Every method's output becomes a field in Hz with topup's sign on the AP b0 grid (`fields.py`).
`calibrate.py` finds the sign that relates topup's field to the sampling displacement: it corrects the first AP b0 with topup's field and keeps the sign that reproduces topup's own `--iout`.
`correct.py` then applies every field the same way: linear interpolation along the PE axis and Jacobian modulation.
Thus the metrics compare fields, not each tool's resampler.

### Gate, ranking and choice

The target is a field as close as possible to topup's.

**Image gate.**
A method passes if its image metrics are close to topup's or better, on every subject:

- **AP-PA agreement.**
  After correction, the mean absolute AP-PA difference in the brain, divided by the mean corrected b0 intensity, is at most 1.1 x topup's value.
- **T1w alignment.**
  The BBR cost of the corrected mean b0 against the T1w white matter (FSL `flirt -cost bbr`, one shared start) is at most 1.02 x topup's value.

**Ranking.**
The methods are ranked by the median absolute difference of their field from topup's in the brain, after the median offset is removed (the demeaned Δfield).
A constant field is a translation along the PE axis.
topup's movement model and the rigid PA-to-AP alignment each absorb a different part of it, so the raw offset is not a property of the field.
On sub-01, topup's own offset from the GRE field map is -5.6 Hz.
The raw Δfield is reported too.
Twice the difference between topup and topup with one b0 per side is a reference line for topup's own spread, not a threshold.

**Choice.**
The licence is a hard filter.
Among the methods that pass the image gate, the cheapest port wins if its mean demeaned Δfield over the six subjects is at most 1.5 x that of the closest method.
Otherwise the closest method wins.

**Reported only:**

- the AP-PA agreement without Jacobian modulation, which does not penalize methods without an intensity model (3dQwarp, ANTs);
- the field difference from the ds005134 GRE field map, raw and demeaned;
- wall time and peak memory with 8 threads.

The brain mask is MindGrab on topup's corrected mean b0, the same for every method.

The issue's original start value, a median absolute difference < 0.5 Hz, cannot be met: topup with one b0 per side already differs from full topup by 0.84 Hz on sub-01.

### Conventions settled on sub-01

Phase 1 found three errors in the first scripts, and each fix comes from the tool's own definition, not from the scores:

- `antsRegistration --restrict-deformation` is a per-stage option. The first run gave it only to the second stage, and the warp had x and z components of up to 2.9 mm.
- FD-Net's K-unit pushes undistorted voxel i to position i + f(i) (`out[j] = Σ_i im[i]·sinc(i + f(i) − j)`), so the correction samples the distorted image at x + f(x). The first conversion had the opposite sign, and its field correlated with topup's at r = −0.90.
- The 3dQwarp `_MINUS` warp applies to the base (AP): resampling AP with it reproduces `qwarp_MINUS` at r = 0.998.

## Results

RESULTS PENDING.

## Port gate

RESULTS PENDING.

## Follow-up issues

RESULTS PENDING.

## Reproduce

The scripts are in [`dwi-reverse-pe-options/`](dwi-reverse-pe-options/).
Set `ROOT` to a scratch directory, then:

```bash
scripts/fetch.sh "$ROOT"
scripts/prep.sh <subject> <ap.nii.gz> <ap.bval|-> <pa.nii.gz> <pa.bval|-> <t1w.nii.gz>
scripts/methods.sh <subject> <method>      # topup first, then the others
scripts/post.sh <subject> <method>...
scripts/gre.sh ds005134-sub-01 <magnitude1.nii.gz> <phasediff.nii.gz>
```

| Tool | Version |
| --- | --- |
| FSL | Neurodesk `fsl_6.0.7.23_20261013` |
| ANTs | Neurodesk `ants_2.6.5_20261012` |
| AFNI | Neurodesk `afni_26.3.04_20261015` |
| QSIPrep (TORTOISE) | `qsiprep:26.1.1`, `sha256:b7d91d9755fd97647632a1f900238425239cd834c97e9866b20af39e224d383a` |
| PyHySCO | 0.0.4, PyTorch 2.8.0 (CUDA 12.8) |
| FD-Net | `2f5c37e`, TensorFlow 2.10.0 (CPU) |
| MindGrab | `@brainchop/mindgrab` 0.1.20260925, CPU, through `@neurodesk/node-drivers` |

The runs used `epic` (32 cores, 123 GB, RTX 5080), with every method limited to 8 threads.
The outputs are not on Hugging Face (follow-up issue 1).

# Diffusion preprocessing and microstructure apps

Design decisions, 18 October 2026. Names and paths below are the plan. They are not implemented APIs until the build order marks them done.

## Goal

Make FA, MD, AD, RD, V1, ICVF, ISOVF and OD maps from diffusion MRI with all processing in the browser.
Each stage is a separate app that is useful alone.
Each app has a portable Node command line that runs the same WebAssembly as the browser.
There is no pipeline app now.
A pipeline specification for all apps in this repository is a later, separate design.

## What the repository already has

| Need | Existing code |
| --- | --- |
| NIfTI + bval + bvec input | `apps/dwi2trx/src/dwi2trx/input.ts` (`resolveInput`, `resolveTriple`) |
| DICOM to NIfTI with bval, bvec and BIDS sidecar | `packages/runtime-support/src/dcm2niix-client/index.ts` (`readImageFiles` pairs each image with its sidecar) |
| bval/bvec parse, b0 index | `packages/dwi2trx/src/gradients.js` |
| Single-shell tensor fit | vendored niimath `--dtifit` (`packages/dwi2trx/src/tensor.js`) |
| Brain mask | MindGrab (`@brainchop/mindgrab`) |
| Affine registration | EdgeReg (`packages/edgereg`, niimath `-allineate`), greedy (`exes/greedy`) |
| Deformable registration | ANTs `antsRegistration` WebAssembly with full argv (`packages/registration/src/main.cxx`) |
| WebGPU U-Net inference | `packages/runtime-support/src/gpu-unet` (conv3d only) |
| Nonlinear least squares | `exes/fida/src/ops/nlinfit.rs`, `exes/lcmodel/src/solve.rs` |

The repository has no denoising, Gibbs unringing, motion correction, susceptibility correction, bias-field correction, b-vector rotation, multi-shell fit, NODDI or BIDS folder reader.

## Apps

| App | Methods | Reference | Gate on cropped ds003138 |
| --- | --- | --- | --- |
| `dwidenoise` | MP-PCA | MRtrix `dwidenoise` | noise map median relative difference < 2 %, denoised NRMSE < 1 % |
| `degibbs` | subvoxel shift | MRtrix `mrdegibbs` | NRMSE < 1 % |
| `n4` | N4 | ANTs `N4BiasFieldCorrection` | field correlation > 0.99 in mask |
| `hmc` | NiFreeze (default), SHORELine | NiFreeze, QSIPrep | motion parameters within 0.2 mm and 0.2° per volume |
| `sdc` | SyN-SDC; later reverse-PE topup and Synb0-DisCo | native ANTs, same schedule | field median absolute difference < 0.5 Hz in brain |
| `noddi` | DTI (WLS, default; niimath dtifit as option), NODDI by AMICO (default), NODDI toolbox, nonlinear fit | FSL `dtifit`; AMICO; NODDI toolbox in Octave; dmipy | FA and MD median absolute difference < 0.01 in WM; NODDI maps < 0.02 in WM |

Each gate is a start value.
Make a gate tighter when the port shows what it can do. Do not make a gate looser.
Compare each NODDI method with its own reference only. The differences between methods are information for About, not a test.

### Rules for every app

- Order of use: denoise, degibbs, (topup), hmc, sdc, n4, mask, fit.
- Inputs: NIfTI + bval + bvec, DICOM, and BIDS folders.
- If the phase-encoding direction or the total readout time is necessary and not in a sidecar, ask for it in an optional sidebar field. Never guess the polarity. Without it, refuse the step that needs it.
- Outputs use BIDS-derivatives names and JSON sidecars, so that the next app can read the output of the last app. Example: `hmc` writes `*_desc-hmc_dwi.nii.gz`, a rotated `.bvec` and `*_desc-hmc_motion.tsv`.
- Each app resamples once. A joint resampling of motion and susceptibility belongs to the later pipeline specification.
- QC plots go in the collapsed console. There is no separate report page.

### Gradient rules

These rules are in the `gradients` crate with tests:

- A volume is b0 when b < 50 s/mm², as in dwi2trx.
- Shells are the non-zero b-values after rounding to the nearest 100 s/mm². Then 995, 1000 and 1005 are one shell.
- NODDI needs two or more non-zero shells. With one shell, `noddi` refuses NODDI and still makes the DTI maps.
- The DTI subset is the b0 volumes plus the lowest non-zero shell. It is not a fixed b ≤ 1000 limit, so b = 700/1200 data also works.

## Code layout

- `exes/dwi` is a Rust workspace. It has one crate per stage and shared crates: `gradients`, `tensor`, voxel-loop, solvers (NNLS, LASSO, Levenberg-Marquardt) and DIPY model ports (SHORE, SH, tensor).
- Each stage has its own WebAssembly build. Each app loads only its module.
- `packages/<stage>` holds the JavaScript wrapper, the committed `.wasm` and the command line, as `packages/easy-mp2rage` does.
- The committed `.wasm` is built with the pinned Rust, wasm-pack and binaryen `version_117` versions. CI rebuilds it and fails when the bytes differ.
- For now the WebAssembly crate includes `exes/synthseg/src/nifti.rs` with `#[path]`, as `packages/synthseg/wasm` does. One shared NIfTI crate for synthseg, synthsr and dwi is a separate change.
- The generic BIDS folder reader goes in `@neurodesk/webapp-components/file-io`. It finds `dwi/*_dwi.nii.gz` with its bval, bvec and JSON, the `fmap/*_epi` files whose `IntendedFor` names that DWI, and `anat/*_T1w`.

## Port sources and licences

| Source | Licence | Use |
| --- | --- | --- |
| AMICO ≤ 1.5.4 (last BSD commit `a8e1a2e381`) | BSD-3-Clause | port candidate for `noddi` |
| AMICO ≥ 2.0.0 | non-commercial custom licence | research-use reference only, never ported |
| dmipy | MIT | port candidate for `noddi` (AMICO and nonlinear) and reference |
| NODDI toolbox 1.05 | Artistic License 2.0 | port for `noddi`; its bundled `erfi.m` has no licence and is not ported |
| NiFreeze | Apache-2.0 | port for `hmc` |
| QSIPrep (SHORELine) | BSD-3-Clause | port for `hmc` |
| MRtrix3 | MPL-2.0 | port for `dwidenoise` and `degibbs`; these crates stay MPL-2.0 per file |
| ANTs | Apache-2.0 | already built to WebAssembly; add an N4 entry point |
| Synb0-DisCo code and weights | MIT | later, for `sdc` |
| FSL (topup, eddy, dtifit) | FSL licence, no port | reference outputs only; topup is a clean-room implementation |

The AMICO source for `noddi` is chosen after a comparison of three candidates on the same data: a port of AMICO 1.5.4, a port of dmipy `amico_cvxpy`, and a clean-room prototype from Daducci et al. 2015.
AMICO 2.1.1, run for research only, is the common comparison.
The person who writes the clean-room prototype does not read the AMICO or dmipy source.

## Data

The primary dataset is OpenNeuro ds003138 (CC0), one subject.
It has b = 1000/2000/3000 at 20/30/64 directions, a reverse-PE b0 for each shell, a 0.8 mm T1w, and `TotalReadoutTime` and `SliceTiming` in its sidecars.
CI uses a cropped field of view.
ds004146 (full AP and PA DWI) is for later work.
Native reference outputs are on the Hugging Face dataset at a pinned revision.

## Build order

1. `exes/dwi` workspace, `gradients` and `tensor` crates, BIDS folder reader.
2. `noddi` with DTI and AMICO.
3. `dwidenoise`.
4. `degibbs`.
5. `n4`, with an N4 entry point in the ANTs WebAssembly build.
6. `hmc`: NiFreeze, then SHORELine.
7. `sdc` with SyN-SDC.
8. NODDI toolbox and nonlinear methods in `noddi`.
9. Later: reverse-PE topup, then Synb0-DisCo.

## Deferred, and why

- **Topup.** FSL's licence does not permit a port. A clean-room implementation from Andersson et al. 2003 is a large separate project.
- **Synb0-DisCo.** Its only use is as the second image for topup. It needs ConvTranspose3d and InstanceNorm3d kernels in `gpu-unet` and fp16 weights converted from the MIT `.pth` files. Its preprocessing uses N4 with WM scaling, MindGrab and EdgeReg. EdgeReg first needs a matrix output from niimath `-allineate`; greedy is the temporary replacement. Outputs are expected to be close to, not equal to, the original pipeline.
- **Eddy-style slice outlier replacement, slice-to-volume motion and least-squares reconstruction of blip-up/down data.** NiFreeze and SHORELine do not have them. FSL eddy cannot be ported.
- **Joint resampling across `hmc` and `sdc`.** It belongs to the pipeline specification.

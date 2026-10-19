# HMC port and validation plan

Plan, 18 October 2026, for step 6 of the [diffusion design](dwi-microstructure-design.md). Readers checked NiFreeze `main` 3bcfb00 and 0.1.0, QSIPrep 26.1.1 SHORELine, DIPY and the repository's ANTs WebAssembly build. A skeptic verified each report against the cited source lines. File:line citations refer to those sources unless a path starts with a repository folder. Nothing here is implemented yet. Section 8 records the decisions (Q50-Q55). Section 9 gives the M0 reference results, which replace the estimates of section 6.

## 1. Crate layout (`exes/dwi`)

| Crate | Status | Content |
|---|---|---|
| `gradients` | reuse, extend | Add a b0 rule for each method. NiFreeze uses `b <= 50` and `b *= |g|` renormalisation (`data/dmri/utils.py:36,269-280`). QSIPrep uses `b < 100` (`cli/parser.py:589-594`). The current rule is `b < 50` and it rejects short vectors (`gradients/src/lib.rs:6,45-58`). |
| `tensor` | reuse, extend | `fit_dipy_wls` follows dipy 1.7 with an f64 Cholesky solve (`tensor/src/lib.rs:106-123`). Add a dipy 1.12.1 variant: `pinv`, float32 log, eigenvalue floor `1e-6/max(B)` (`dti.py:1476-1512`). |
| `hmc` | new | Dataset, b0 split, `advanced_clip`, leave-one-out loop, motion decomposition, bvec rotation, TSV. |
| `gp` | new | Spherical kriging kernel, sklearn log marginal likelihood, L-BFGS-B. |
| `shore` | new | BrainSuite 3dSHORE basis, ridge solve, leave-neighbourhood-out rule. |
| `hmc-wasm` | new | wasm-bindgen entry, as in `noddi-wasm`. |

Put ANTs in a new package `packages/hmc-registration` beside `packages/registration`, as `packages/n4` does (`n4/README.md:4`). Do not change `packages/registration`. Its wasm is sha256-pinned (`src/node.js:6`), and SYNcro parity depends on it.

## 2. Registration engine

Use the ANTs 52bc0ab WASM kernel for both methods. Do not use greedy for parity, because its NMI metric is different from GC and Mattes. Greedy can be a later "fast" option with no parity claim.

Changes in the new module:
- Add `antsRegistration3DDouble.cxx` and remove its stub (`unsupported.cxx:10`). NiFreeze emits no `--float` (`nipype registration.py:463-467`), so ANTs selects double (`antsRegistration.cxx:706-746`). Section 9 gives the `--float 1` measurement (Q53). Do not build 3DDouble before the decision on it.
- Add `AverageImages` and `AverageAffineTransform` entry points. Add `--apply` with HammingWindowedSinc, LanczosWindowedSinc and BSpline. Today `--apply` has only linear and nearest (`apply.cxx:28-31`).
- Expose a generic `run(argv)`. Always pass `--random-seed`, because ENV is not exported (`CMakeLists.txt:37`). The kernel uses one thread (`main.cxx:15`).

NiFreeze argv:
- Use `b0-to-b0_level0` verbatim (`registration/ants.py:280-295`). Add `--masks [ brainmask, NULL ]` after each stage (`ants.py:412-415`). M0 confirmed it: NiFreeze 3bcfb00 uses `b0-to-b0_level0` for every volume, and no code path selects `dwi-to-b0_level0`.
- Settings: GC Rigid[12.0]/[1.96], Random 0.4/0.18, 20 + 10 iterations, shrink 3/2, smoothing 2.71/0 vox, histogram matching on, winsorize [0.063, 0.991], no `-r`, double precision. Each stage stops at its iteration limit, not by convergence.
- Fixed = prediction. Moving = raw volume.
- `--align-config` has no effect (`ants.py:400-404`).

SHORELine argv:
- Use the strings that container nipype 1.11.0 renders from `shoreline_precise_Affine.json` (model stage) and `shoreline_precise_Rigid.json` (b0 stage). The b0 stage is always Rigid (`hmc.py:241,273-274`).
- Settings: `--float 1`, Mattes 48 bins, Random 0.15/0.2, smoothing 8x2 mm / 2 mm, shrink 2x1/1, winsorize [0.002, 0.998], BSpline.
- Fixed = prediction. Moving = original volume. No initial transform (`hmc.py:618-622`).
- Capture the real cmdline from the work directory. M0 did this: `hmc/reference/qsiprep-r1/collected/{b0,model}/*/NNN/command.txt`.

## 3. Model ports and numerical risks

- **NiFreeze `trivial`** is the CLI default (`cli/parser.py:85-101`). The target is the b0, or the median of the b0s.
  - Risk: `advanced_clip` must match exactly. It uses a median filter with `ball(3)`, percentiles 35/99.98 of the filtered values, a clip of the unfiltered data and `round(255x)` (`data/filtering.py:64-177`).
  - The clip writes in place only for float arrays (`filtering.py:116-117`).
  - `_to_nifti` calls the clip with `inplace=True` (`registration/ants.py:83-87`). The trivial model returns `dataset.bzero` itself, which is float64. Thus the first visit writes the clipped map into `dataset.bzero`, and each later visit clips the clipped map again. On ds005577 the second clip changes nothing (section 9), but on other data it can, and then the visit order changes the result. The port copies this (Q55).
  - Read the scipy `median_filter` boundary mode before the port.
- **NiFreeze GP** is on main 3bcfb00 only. PyPI 0.1.0 has no GP (`0.1.0 model/base.py:63-74`).
  - Kernel: spherical kriging + WhiteKernel. a is in (0.1, 2.35) and starts at 0.1, on its bound. lambda starts at 2.0. alpha is 1e-10, with `normalize_y` (`model/_dipy.py:115-121,232-237`; `model/gpr.py:54-57,694,757-759`).
  - One shared hyperparameter set is fitted again for each volume.
  - The DWI model writes `False` into `dataset.brainmask` where `bzero < 1e-5` (`model/dmri.py` `_compute_data_mask`), before NiFreeze writes the registration mask. The GP runs therefore register with, and fit on, the mask minus those voxels (11 voxels on ds005577). The trivial model does not do this.
  - On ds005577 every fit stops with a and lambda on their lower bounds (section 9). Copy the bounds, L-BFGS-B and `normalize_y` exactly.
  - Risks: L-BFGS-B active-bound handling, the sum over voxel targets, the scipy defaults and the WhiteKernel bounds. Read these from the installed versions. Do not use values from memory.
- **3dSHORE** is the QSIPrep default. Port the BrainSuite basis, not dipy `ShoreModel`.
  - Basis: 72 columns, odd n included, n-outer order (`utils/brainsuite_shore.py:531-541,673-679`). SH with Condon-Shortley phase (`utils/shm.py:243-317`). zeta 700, q = sqrt(b).
  - The 1e-8 ridge is load-bearing, because rank(M) is 29-65 of 72. A `pinv` or `lstsq` port fails.
  - Compute `w = m_predᵀ solve(A, Mᵀ)` one time for each target, and apply it to all voxels.
  - Write `0⁰ = 1` explicitly.
- **SHORELine tensor** uses dipy 1.12.1 WLS. Outside the mask the target is `max(b0_mean, 1e-4)`, not 0 (`dti.py:25,2362-2393`).

## 4. b-vectors and outputs

| Item | NiFreeze | SHORELine |
|---|---|---|
| Rotation | voxel 3x3 of `inv(A) inv(M) A`, no renormalisation (`data/dmri/utils.py:312-317`) | inverse affine on points 0 and 5v, LPS world, renormalised (`interfaces/gradients.py:1028-1060`) |
| Precision | `%.6f` | `%.8f` |

Port both rules exactly for the harness. The app output uses the rule of the selected method.

The app writes a BIDS derivative:
- `*_desc-hmc_dwi.nii.gz`, with the b0 volumes kept.
- `*_desc-hmc_dwi.bvec` and `*_desc-hmc_dwi.bval`.
- `*_desc-hmc_motion.tsv`.
- One ITK `.mat` transform for each volume.

TSV columns:
- `trans_x trans_y trans_z` in mm.
- `rot_x rot_y rot_z` in rad, as a rotation vector.
- `framewise_displacement` (SPM convention, 50 mm radius).

The frame is RAS+. NiFreeze matrices map reference to scan in RAS. Decompose them with the same code.

Translation: QSIPrep's `get_ras_motion_params` (`interfaces/gradients.py:905-944`) moves the point `A[:3,:3]·c`, with `c = (shape-1)/2`. That is the grid centre minus the origin, not the world grid centre `A·c`. On ds005577 the origin is about 190 mm from the grid centre, so this translation is larger than the world-centre one by about |θ| × 190 mm (trivial b1000: 3.0 mm against 1.5 mm). The TSV uses QSIPrep's formula word for word, because the port must match it to 1e-6. The M0 comparison files give both.

## 5. Reference runs and gates

First, record the dtype, `scl_slope` and b0 count of both datasets. On float data the in-place clip makes the volume order change the result. This decides whether volumes can run in parallel.

- **NiFreeze**, main 3bcfb00, Python 3.12:
  - Command: `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 nifreeze dwi.nii.gz --gradient-file dwi.bvec dwi.bval --brainmask mask.nii.gz --models trivial --seed 1234 --nthreads 1 --write-hdf5 --output-dir out`. The mask is MindGrab (`mindgrab` model) of the mean b0 (Q52).
  - Run it again with `--models gp`.
  - The HDF5 file holds `motion_affines`.
  - Patch the temporary directory so that it keeps `sample_*`, `predicted_*` and `*0GenericAffine.mat`.
- **QSIPrep** 26.1.1 container (ANTs 2.6.0.dev1-gb775a15):
  - Command used in M0: `qsiprep bids out participant --participant-label 107 --output-resolution 2 --anat-modality none --hmc-method shoreline --denoise-method none --unringing-method none --dwi-biascorrect none --ignore sdc --nthreads 1 --omp-nthreads 1 -w work --skip-bids-validation --notrack --stop-on-first-crash`. `--anat-modality none` is the DWI-only flag. QSIPrep then registers the b0 template to MNI152NLin2009cAsym for its ACPC space, which does not change the HMC transforms.
  - Keep `work`. `config.toml` records the seeds that QSIPrep drew (master, ants, numpy).
  - Run it three times, because SHORELine has no seed option (`config.py:751-778`).
  - QSIPrep takes no external mask for HMC. It makes a SynthStrip mask of its b0 template (Dice 0.947 against the MindGrab mask on ds005577).

Gates:
- Deterministic checks:
  - Decomposing the reference `.mat` files gives `motion_params.csv` to 1e-6.
  - The SHORE prediction on the reference inputs agrees to 1e-5 relative.
  - bvec rotation agrees to the printed precision.
- Registration: first replay the kept inputs, then run end to end. For each volume, |Δt| ≤ 0.2 mm and |Δrot| ≤ 0.2° on each axis.
- If the QSIPrep repeat spread is above the gate, stop and report it.
- On the slab, report the through-plane axes separately. ds005577 is the main SHORELine gate.

## 6. Runtime and memory

The first estimates (2-10 s for each call, NiFreeze trivial 1-6 min, SHORELine 10-40 min) were too low for SHORELine. M0 measured the native reference tools on ds005577 (120 × 120 × 75 × 101, 2 mm, 90 DWI volumes), one thread for everything:

| Run | Wall time | Per DWI volume | Peak memory |
| --- | --- | --- | --- |
| NiFreeze trivial, double | 407-421 s | about 4.6 s | 0.83-0.97 GB |
| NiFreeze GP, double | 647-707 s | about 7.5 s | 1.35-1.38 GB (with the scikit-learn patch, section 9) |
| QSIPrep SHORELine, 2 iterations, Affine | 17954 s (5.0 h) | 74 s for each iteration: registration 40.8 s + SHORE prediction 32.8 s (mean of the 180 nipype nodes of each kind) | 7.54 GB (cgroup peak, page cache included) |

- The GP fit without the patch needs about 11.5 GB: scikit-learn 1.9.1 builds an (89, 89, 161668) float64 array (10.2 GB) for the gradient. The port must sum over the targets first, as the patch does.
- QSIPrep time by node: model-stage registrations 7335 s, SHORE predictions 5897 s, b0 template registrations 2238 s (22 × 102 s, Rigid, 1000 iterations). The remaining 2.5 ks is conform, SynthStrip, ACPC registration and outputs.
- The GP target memory estimate stays: about 1.6e5 mask voxels × 90 volumes.
- Anchors for the WASM build: SYNcro WASM, affine + SyN at 1 mm, 186 s (`packages/syncro/validation/README.md:33`); N4 on the slab, 1.9 s (`packages/n4/README.md:22`). Each kernel starts at 256 MiB (`CMakeLists.txt:35`), so 4 workers need about 1 GiB.

Replace the WASM numbers with the milestone M3 benchmark.

## 7. Milestones

1. M0: reference runs, kept intermediates and masks, pinned on Hugging Face. Status: NiFreeze runs done; QSIPrep r1 done, r2 and r3 not done; upload not done (section 9).
2. M1: `hmc` motion decomposition, bvec rotation and TSV, tested with the reference `.mat` files.
3. M2: `hmc-registration` with generic argv, and 3DDouble if the Q53 decision needs it. Replay the reference inputs.
4. M3: NiFreeze `trivial` end to end, Node CLI, benchmark.
5. M4: `shore`, b0 template and SHORELine iterations.
6. M5: `gp`.
7. M6: SHORELine tensor option, then the app UI, example and e2e tests.

## 8. Questions and decisions

1. Which NiFreeze model is the app default: `trivial` (the CLI default) or GP (main only, not released)?
   **Decided (Q50):** GP is the app default. `trivial` is an option. M0 supports this: on ds005577 the trivial model fails on b3000 (section 9).
2. Do we pin NiFreeze main 3bcfb00, or wait for a release with GP?
   **Decided (Q50):** pin NiFreeze `main` 3bcfb00.
3. Do we keep the b0 volumes in the output? NiFreeze drops them.
   **Decided (Q51):** keep the b0 volumes in the outputs.
4. What is the browser mask source? SynthStrip is not ported.
   **Decided (Q52):** MindGrab (model `mindgrab`) of the mean b0 by default; the user can upload a mask. The reference runs use a MindGrab mask made with `@neurodesk/node-drivers/mindgrab`, so the port can use the same mask. QSIPrep cannot take it; it uses its own SynthStrip mask.
5. Can NiFreeze use `--float 1` if a measurement shows it within the gate? Then 3DDouble is not necessary.
   **Decided (Q53):** measure `--float 1` against double before anyone builds 3DDouble. Measured (section 9): within the gate on b0→b0, not within the gate for GP (7/90 volumes), but smaller than NiFreeze's own seed noise. **Open:** the user decides whether 3DDouble is needed and whether the 0.2 mm / 0.2° gate is useful against that noise.
6. Is a QSIPrep run on the slab acceptable, and which flag skips the anatomical input?
   **Decided (Q54):** QSIPrep 26.1.1 SHORELine on ds005577 (whole brain, not the slab), three repeats. The flag is `--anat-modality none` (section 5).
7. Must the port copy the in-place clip quirk on float data, or only run the integer path?
   **Decided (Q55):** copy the quirk, and record whether the input is float or integer. ds005577 is int16 (no scaling), so the DWI data is not clipped in place. But the trivial model's target (`bzero`) is float64, so the quirk is active there (section 3).

## 9. M0 results

Measured 18-19 October 2026. Data: Hugging Face dataset `neurodeskorg/webapps`, path `hmc/reference/` (local folder ready, upload and revision pending). Its README gives the commands, versions, patches and the purpose of each file. Use that path in the M1-M5 manifests.

### Input and environment

- OpenNeuro ds005577 v1.0.0 sub-107 AP DWI, CC0 (read from `dataset_description.json`), copied unchanged. SHA-256 `06d5a733005a9e463f1ca6b581d0a8725378b60967c23dd63d49cc04362e83b9`.
- 120 × 120 × 75 × 101, 2 mm, int16. `scl_slope` and `scl_inter` are NaN, so there is no scaling.
- 11 b0 volumes (0, 10, …, 100) under both b0 rules, 30 × b1000 and 60 × b3000. The shells alternate in time, one volume every 3.2 s.
- NiFreeze 3bcfb00, Python 3.12.13, nipype 1.12.0, nitransforms 25.1.0, numpy 2.3.5, scipy 1.18.1, scikit-learn 1.9.1.
- Native ANTs 2.6.2 at 52bc0ab (the commit of the WASM build): CMake `-G Ninja`, Release, static.
- QSIPrep 26.1.1 container, digest `sha256:b7d91d97…d383a`.
- One thread for everything.
- Two patches:
  - NiFreeze: keep the work directory, and an optional `--float 1` switch. It does not change results.
  - scikit-learn GP gradient: it sums over the targets first. Gradient change at most 3.3e-15 relative. Without it the GP needs about 11.5 GB.

### Mask

- MindGrab `mindgrab` model, of the mean of the 11 raw b0 volumes, with `@brainchop/mindgrab` 0.1.20260925 through `loadMindgrabCpu`.
- 161679 voxels (1293 mL), bounding box 126 × 168 × 136 mm. It does not touch the grid edge, and it has the DWI grid and affine.
- The GP runs used 161668 voxels: NiFreeze removes the voxels where the b0 median is 0 (section 3).
- QSIPrep's own SynthStrip mask: Dice 0.947 against the MindGrab mask.

### Determinism

- NiFreeze trivial run twice with `--seed 1234`: transforms, visit order and motion are equal bit for bit.
- 4 kept `cmd-*.sh` files, run again with `ANTS_RANDOM_SEED=1234`, gave the same `.mat` byte for byte.
- GP was not repeated with the same seed.
- In all six NiFreeze runs, the samples (moving images) are byte-identical and equal to the raw volumes.
- The trivial prediction is the same file for all 90 volumes. The in-place clip of `bzero` happens, but the second clip changes nothing on this input (35th percentile 0, 99.98th 255).

### Registration quality (median correlation with the mean of the raw shell, before → after)

| Model | b1000 r | b3000 r | Median mask displacement | Comment |
| --- | --- | --- | --- | --- |
| trivial | 0.895 → 0.807 | 0.627 → 0.363 | 1.5 mm (b1000), 7.4 mm (b3000), maximum 42 mm | fails: every volume gets worse |
| GP | 0.895 → 0.910 | 0.627 → 0.674 | 0.34 mm (b1000), 0.42 mm (b3000) | no volume gets worse; maximum 1.84 mm, 0.71° |

- The trivial target is the b0 map, and a b3000 volume does not correlate with it (r ≈ 0.00).
- The "motion" of the trivial run follows the b-value, not the time, so it is not subject motion.
- The b0→b0 registrations move only 0.0-0.3 mm and up to 0.35°.
- GP: in all 90 fits `beta_a` stopped at its lower bound 0.1 and `beta_l` at 0.001. The kernel is `SphericalKriging(a=0.1, λ=0.001) + WhiteKernel(0.999)`. The prediction is almost the voxel mean of the other 89 volumes of both shells (r = 0.993). M5 must copy the bounds, L-BFGS-B and `normalize_y` to match it.

### Q53: `--float 1` against double (gate 0.2 mm / 0.2° per axis)

| Comparison | Over gate, world centre | Over gate, QSIPrep formula | Max \|Δt\| | Max \|Δrot\| |
| --- | --- | --- | --- | --- |
| trivial, float vs double | 55/90 | 66/90 | 42 mm | 6.1° |
| b0→b0, 11 pairs, float vs double | 0/11 | 0/11 | 0.018 mm (QSIPrep 0.178) | 0.052° |
| b0→b0, double, seed 1234 vs 1235 | 0/11 | 4/11 | 0.109 mm (QSIPrep 0.337) | 0.127° |
| GP, float vs double | 7/90 | 30/90 | 0.29 mm (QSIPrep 1.08) | 0.35° |
| GP, double, seed 1234 vs 1235 | 68/90 | 85/90 | 0.71 mm (mask displacement up to 1.7 mm) | 0.79° |

- **Trivial:** double itself fails here, so this row does not measure precision.
- **b0→b0:** on a well-posed registration, float is within the gate, and its error is smaller than the error of a different seed.
- **GP (the app default):** float is not within the gate.
- **Seed noise:** a change of seed in double moves the GP result more than float does, by more than the gate and by about as much as the GP motion itself (0.3-0.7 mm median). The cause is NiFreeze's Random sampling and the fixed iteration limits, which make the result depend on the path.
- The decision on 3DDouble and on the gate is open (section 8, question 5).

### QSIPrep SHORELine

- r1: wall time 17954 s, peak memory 7.54 GB. Seeds: master 53847, ants 57526, numpy 18755.
- The final `.mat` files decompose to QSIPrep's `motion_params.csv` with a largest difference of 1.5e-14 mm.
- DWI motion: maximum 0.57 mm, 0.86°, |scale − 1| ≤ 0.025.
- GP against QSIPrep r1, median offset removed: median |Δt| 0.03-0.14 mm, 65/90 volumes over the gate. This is for information only: the methods differ (Rigid against Affine).
- **Repeat spread: not measured yet.** r2 is running and r3 has not started. If the spread of the three runs is above the gate, stop and report it (section 5).
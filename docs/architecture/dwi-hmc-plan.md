# HMC port and validation plan

Plan, 18 October 2026, for step 6 of the [diffusion design](dwi-microstructure-design.md). Readers checked NiFreeze `main` 3bcfb00 and 0.1.0, QSIPrep 26.1.1 SHORELine, DIPY and the repository's ANTs WebAssembly build. A skeptic verified each report against the cited source lines. File:line citations refer to those sources unless a path starts with a repository folder. Nothing here is implemented yet; section 8 lists the decisions still open.

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
- Add `antsRegistration3DDouble.cxx` and remove its stub (`unsupported.cxx:10`). NiFreeze emits no `--float` (`nipype registration.py:463-467`), so ANTs selects double (`antsRegistration.cxx:706-746`).
- Add `AverageImages` and `AverageAffineTransform` entry points. Add `--apply` with HammingWindowedSinc, LanczosWindowedSinc and BSpline. Today `--apply` has only linear and nearest (`apply.cxx:28-31`).
- Expose a generic `run(argv)`. Always pass `--random-seed`, because ENV is not exported (`CMakeLists.txt:37`). The kernel uses one thread (`main.cxx:15`).

NiFreeze argv:
- Use `b0-to-b0_level0` verbatim (`registration/ants.py:280-295`). Add `--masks [ brainmask, NULL ]` after each stage (`ants.py:412-415`).
- Settings: GC Rigid[12.0]/[1.96], Random 0.4/0.18, shrink 3/2, histogram matching on, winsorize [0.063, 0.991], no `-r`, double precision.
- Fixed = prediction. Moving = raw volume.
- `--align-config` has no effect (`ants.py:400-404`).

SHORELine argv:
- Use the strings that container nipype 1.11.0 renders from `shoreline_precise_Affine.json` (model stage) and `shoreline_precise_Rigid.json` (b0 stage). The b0 stage is always Rigid (`hmc.py:241,273-274`).
- Settings: `--float 1`, Mattes 48 bins, Random 0.15/0.2, smoothing 8x2 mm / 2 mm, shrink 2x1/1, winsorize [0.002, 0.998], BSpline.
- Fixed = prediction. Moving = original volume. No initial transform (`hmc.py:618-622`).
- Capture the real cmdline from the work directory.

## 3. Model ports and numerical risks

- **NiFreeze `trivial`** is the CLI default (`cli/parser.py:85-101`). The target is the b0, or the median of the b0s.
  - Risk: `advanced_clip` must match exactly. It uses a median filter with `ball(3)`, percentiles 35/99.98 of the filtered values, a clip of the unfiltered data and `round(255x)` (`data/filtering.py:64-177`).
  - The clip writes in place only for float arrays (`filtering.py:116-117`).
  - Read the scipy `median_filter` boundary mode before the port.
- **NiFreeze GP** is on main 3bcfb00 only. PyPI 0.1.0 has no GP (`0.1.0 model/base.py:63-74`).
  - Kernel: spherical kriging + WhiteKernel. a is in (0.1, 2.35) and starts at 0.1, on its bound. lambda starts at 2.0. alpha is 1e-10, with `normalize_y` (`model/_dipy.py:115-121,232-237`; `model/gpr.py:54-57,694,757-759`).
  - One shared hyperparameter set is fitted again for each volume.
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

The frame is RAS+. Translation is about the grid centre `(shape-1)/2` (`interfaces/gradients.py:905-944`). NiFreeze matrices map reference to scan in RAS. Decompose them with the same code.

## 5. Reference runs and gates

First, record the dtype, `scl_slope` and b0 count of both datasets. On float data the in-place clip makes the volume order change the result. This decides whether volumes can run in parallel.

- **NiFreeze**, main 3bcfb00, Python 3.12:
  - Command: `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1 nifreeze dwi.nii.gz --gradient-file dwi.bvec dwi.bval --brainmask mask.nii.gz --models trivial --seed 1234 --nthreads 1 --write-hdf5 --output-dir out`.
  - Run it again with `--models gp`.
  - The HDF5 file holds `motion_affines`.
  - Patch the temporary directory so that it keeps `sample_*`, `predicted_*` and `*0GenericAffine.mat`.
- **QSIPrep** 26.1.1 container (ANTs 2.6.0.dev1-gb775a15):
  - Command: `qsiprep bids out participant --participant-label 01 --hmc-method shoreline --nthreads 1 --omp-nthreads 1 -w work`, plus the DWI-only flag. That flag is not verified yet.
  - Keep `work`. Read the seed from `config.toml`.
  - Run it three times, because SHORELine has no seed control (`config.py:751-778`).

Gates:
- Deterministic checks:
  - Decomposing the reference `.mat` files gives `motion_params.csv` to 1e-6.
  - The SHORE prediction on the reference inputs agrees to 1e-5 relative.
  - bvec rotation agrees to the printed precision.
- Registration: first replay the kept inputs, then run end to end. For each volume, |Δt| ≤ 0.2 mm and |Δrot| ≤ 0.2° on each axis.
- If the QSIPrep repeat spread is above the gate, stop and report it.
- On the slab, report the through-plane axes separately. ds005577 is the main SHORELine gate.

## 6. Runtime and memory (planning estimate)

No HMC measurement exists. The two anchors are:
- SYNcro WASM, affine + SyN at 1 mm: 186 s (`packages/syncro/validation/README.md:33`).
- N4 on the slab: 1.9 s (`packages/n4/README.md:22`).

A rigid 2-stage GC call on a 2 mm brain is much smaller than SyN. Plan 2-10 s for each call.
- NiFreeze trivial, 130 volumes, 4 workers: about 1-6 min.
- SHORELine precise (1000 iterations, two passes, Affine, plus the b0 template): about 10-40 min.

Memory:
- Each kernel starts at 256 MiB (`CMakeLists.txt:35`), so 4 workers need about 1 GiB.
- GP targets: about 3e5 voxels x 136 volumes x 4 B ≈ 160 MB float32.

Replace these numbers with the milestone M3 benchmark.

## 7. Milestones

1. M0: reference runs, kept intermediates and masks, pinned on Hugging Face.
2. M1: `hmc` motion decomposition, bvec rotation and TSV, tested with the reference `.mat` files.
3. M2: `hmc-registration` with 3DDouble and generic argv. Replay the reference inputs.
4. M3: NiFreeze `trivial` end to end, Node CLI, benchmark.
5. M4: `shore`, b0 template and SHORELine iterations.
6. M5: `gp`.
7. M6: SHORELine tensor option, then the app UI, example and e2e tests.

## 8. Open questions

1. Which NiFreeze model is the app default: `trivial` (the CLI default) or GP (main only, not released)?
2. Do we pin NiFreeze main 3bcfb00, or wait for a release with GP?
3. Do we keep the b0 volumes in the output? NiFreeze drops them.
4. What is the browser mask source? SynthStrip is not ported. One option: the reference mask as a fixture now, MindGrab later.
5. Can NiFreeze use `--float 1` if a measurement shows it within the gate? Then 3DDouble is not necessary.
6. Is a QSIPrep run on the slab acceptable, and which flag skips the anatomical input?
7. Must the port copy the in-place clip quirk on float data, or only run the integer path?
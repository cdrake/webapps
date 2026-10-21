# @neurodesk/hmc-registration

ANTs `antsRegistration`, `AverageImages`, `AverageAffineTransform` and an antsApplyTransforms-style `--apply`, compiled to WebAssembly with a generic `run(argv)`, for DWI head-motion correction (and later susceptibility distortion correction).
It is a separate module from `@neurodesk/registration`, at the same pinned ANTs commit and ITK-Wasm toolchain, so the SYNcro and ANTs kernels do not change.

## Use

In Node:

```js
import { readMatTransform } from '@neurodesk/hmc-registration';
import { loadHmcRegistration } from '@neurodesk/hmc-registration/node';

const ants = await loadHmcRegistration();
const { outputs, log } = ants.run(
  ['--dimensionality', '3', '--float', '1', '--random-seed', '1234',
   '--transform', 'Rigid[0.1]', '--metric', 'Mattes[fixed.nii,moving.nii,1,32,Regular,0.25]',
   '--convergence', '[100x50,1e-6,10]', '--shrink-factors', '2x1', '--smoothing-sigmas', '1x0vox',
   '--output', '[out]'],
  { 'fixed.nii': fixedBytes, 'moving.nii': movingBytes },
);
const { parameters, fixed } = readMatTransform(outputs['out0GenericAffine.mat']);
```

In a browser, run it in the module worker:

```js
const worker = new Worker(new URL('@neurodesk/hmc-registration/worker', import.meta.url), { type: 'module' });
worker.postMessage({ id: 1, argv, inputs: { 'fixed.nii': fixedBytes, 'moving.nii': movingBytes } });
worker.onmessage = ({ data }) => { /* { id, outputs, log } or { id, error, log } */ };
```

The kernel is linked with `-pthread`, so its memory is a `SharedArrayBuffer`: the page must be cross-origin isolated (COOP `same-origin`, COEP `require-corp`).
A message can carry `kernel: { module, wasm }` URLs when a bundler moved the kernel files.

`run(argv, inputs)` writes each input into a new directory of the virtual file system, runs the program there (argv names files relative to it), returns every file the run wrote, and removes the directory.
A `.nii.gz` input is read as gzipped NIfTI; ANTs picks the reader by file name.
A failed run throws an error whose message ends with the last log lines; `error.log` holds the whole log.
A run that exits non-zero leaves the kernel usable.
Some mistakes, such as an input that argv names but `inputs` does not hold, make the kernel abort (trap) instead: the error then has `aborted: true`, and that instance refuses later runs, so load a new one.
The worker does this itself: its next message loads a new kernel.
`run` refuses an `--output` prefix whose directory does not exist before the kernel runs, as ANTs aborts on it.

## Programs

`argv[0]` selects the program; any other argv is `antsRegistration`'s, without the program name.
The worker takes the same argv.

| `argv[0]` | Arguments after it | Source |
| --- | --- | --- |
| `AverageImages` | `3 output.nii normalize image...` | ANTs `Examples/AverageImages.cxx`, unchanged |
| `AverageAffineTransform` | `3 output.mat [-R reference] {[-i] transform [weight]}...` | ANTs `Examples/AverageAffineTransform.cxx`, unchanged |
| `--apply` | `fixed moving output interpolation fill transform...` | `src/apply.cxx` |

The SHORELine template step of QSIPrep, in this module:

```js
ants.run(['AverageImages', '3', 'template.nii', '1', 'b0-1.nii', 'b0-2.nii'], images);
ants.run(['AverageAffineTransform', '3', 'average.mat', 'a.mat', 'b.mat'], transforms);
ants.run(['--apply', 'template.nii', 'template.nii', 'updated.nii', 'HammingWindowedSinc', '0', 'inverse:average.mat'], files);
```

`--apply` resamples `moving` onto the grid of `fixed`.
`interpolation` is `Linear`, `NearestNeighbor`, `BSpline` (order 3), `BSpline[0]` to `BSpline[5]`, `HammingWindowedSinc` or `LanczosWindowedSinc`, as antsApplyTransforms names them (case does not matter).
`fill` is the value of voxels that map outside `moving`.
A transform written `inverse:name` is inverted, as `[name,1]` in antsApplyTransforms.
The last transform listed acts first on a point, as on the antsApplyTransforms command line.
Pixels are float32 in and out; interpolation and transforms are double, as antsApplyTransforms without `--float`.
The interpolators are the ones antsApplyTransforms builds (`make_interpolator_snip.tmpl`): windowed sinc with radius 3 and a constant (zero) boundary, B-spline with double coefficients.
`packages/registration`'s `--apply` (SYNcro, ANTs) does not change: it still has only linear and nearest.

The kernel is built without C++ exception catching, so an ITK reader that fails on a missing file aborts it.
For these three programs `run` refuses, before the kernel runs, an input that argv names but `inputs` does not hold, and an argument that holds a directory.
`--apply` reports an unknown interpolation, a fill that is not a number, or no transform with exit 1; the kernel stays usable.

### Interpolators in the reference pipelines

- QSIPrep 26.1.1 writes the output DWI with antsApplyTransforms `--float` (`workflows/dwi/resampling.py`, `dwi_transform`). `ChooseInterpolator` (`interfaces/images.py`) picks `LanczosWindowedSinc`, or `Linear` when the output voxels are more than 10 % finer than the input or in sloppy mode.
  In SHORELine (`workflows/dwi/hmc.py`) the b0 template is averaged with `AverageImages` (normalize 1) and `AverageAffineTransform` and resampled through the inverse average with `HammingWindowedSinc`; the b0-based initial transforms use `BSpline`; the model images go back to the original space with `LanczosWindowedSinc`.
- NiFreeze 3bcfb00 does not use ANTs to write the output DWI. `to_nifti` (`nifreeze/data/base.py`) resamples each volume with `nitransforms.resampling.apply` at `order=3`: a cubic spline from SciPy, the nearest equivalent of `BSpline` here.

## Rules

- For `antsRegistration`, `run` refuses argv without exactly one `--float 1`, in JavaScript, before the kernel runs. Only `antsRegistration3DFloat` is compiled; `src/unsupported.cxx` (a copy of `packages/registration`'s) refuses 2D, 4D and every double mode, 3D double included.
- For `antsRegistration`, `run` refuses argv without exactly one `--random-seed N`, N an integer from 1 to 2147483647. Without it ANTs seeds from the clock. The seed is never taken from the environment: `ENV` is not in `EXPORTED_RUNTIME_METHODS` (only `FS` and `callMain`), so `ANTS_RANDOM_SEED` cannot reach the kernel.
- The kernel uses one ITK thread (`src/main.cxx`), so results do not depend on the host.
- Memory starts at 256 MiB (`INITIAL_MEMORY=268435456`) and grows to at most 4 GiB (`MAXIMUM_MEMORY`), as `packages/registration`: four workers start at about 1 GiB.
- Node and the worker refuse a `.wasm` whose SHA-256 is not `HMC_REGISTRATION_WASM_SHA256` (`src/pin.js`).

## Parity

`test/data` holds a 32³ 2 mm pair of three Gaussian blobs, the moving image moved by (3, −2, 4) mm RAS, both sampled from the formula (`scripts/make-test-data.mjs`).
Native `antsRegistration` built from ANTs 52bc0ab (SuperBuild, Release, `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1`) and this module, in Node and in a Chromium worker, write the same `out0GenericAffine.mat`, byte for byte, with the argv in `test/expected.mjs` (seed 1234).
Its translation is (−2.994, 2.008, 4.007) mm LPS, the shift within 0.01 mm.
The tests pin that file's SHA-256.
The replay of NiFreeze's own registration commands against native double precision is #446.

`validation/native-reference.sh` runs the SHORELine steps with native ANTs 52bc0ab on the same pair: registrations with seeds 1234 and 4321, `AverageAffineTransform` of the two, `antsApplyTransforms -u float` with each interpolator, `HammingWindowedSinc` through the inverse average, and `AverageImages` with normalize 0 and 1.
Native `AverageImages` and `AverageAffineTransform` come from the same configuration as the native `antsRegistration` (the `ANTS-build` cache options, with `ANTS_BUILD_AverageImages` and `ANTS_BUILD_AverageAffineTransform` on).
`test/programs.test.js` (Node) and `validation/browser-worker.mjs` (Chromium worker) run the same steps in this module.
Every output file is native ANTs's, byte for byte (`NATIVE_SHA256` in `test/expected.mjs`): the tolerance is 0, inside the 1e-5 relative limit of #445.
The `--apply` outputs equal antsApplyTransforms in its default double precision; with `--float 1` native ANTs differs from them by at most 5.1e-7 of the image maximum.
Over the central 16³ voxels, `--apply` brings the moving image from 0.38 of the fixed maximum to 0.013 (Linear), 0.0025 to 0.0026 (B-spline), 0.0039 (Hamming), 0.0063 (Lanczos) and 0.075 (nearest neighbour); the tests hold these to 0.02 (0.1 for nearest neighbour).
`AverageImages` with normalize 0 is the voxel mean of its inputs, to float precision.

## Tests

```bash
pnpm --filter @neurodesk/hmc-registration test          # Node
pnpm --filter @neurodesk/hmc-registration test:browser  # Chromium module worker
```

To rerecord the native SHA-256 values: `bash packages/hmc-registration/validation/native-reference.sh <ants-bin-dir> <out-dir>`.

`test:browser` needs a Playwright Chromium (`node node_modules/@playwright/test/cli.js install chromium`).
CI runs `test` in `pnpm test:packages` and `test:browser` in `.github/workflows/hmc-registration.yml`.

## Rebuild

Docker, curl and tar are required:

```bash
bash packages/hmc-registration/scripts/build.sh /var/tmp/hmc-registration-build
```

The script downloads ANTs at `52bc0ab588102682587303d31c720de94e6ef6c1` and compiles in `itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d`, one job, with an 8 GB container limit (`HMC_REGISTRATION_BUILD_MEMORY`).
`SOURCE_DATE_EPOCH` fixes the `__DATE__` and `__TIME__` that `ANTsVersion.cxx` embeds at the ANTs commit time, so the build is reproducible: two builds from empty directories wrote the same `.wasm` (12 096 078 bytes, SHA-256 `5c51d581…`).
A build took about 2.6 minutes.
When a source or the toolchain changes, put the printed SHA-256 in `src/pin.js`.

# @neurodesk/hmc-registration

ANTs `antsRegistration` compiled to WebAssembly, with a generic `run(argv)`, for DWI head-motion correction (and later susceptibility distortion correction).
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

`run(argv, inputs)` writes each input into a new directory of the virtual file system, runs `antsRegistration` there (argv names files relative to it), returns every file the run wrote, and removes the directory.
A `.nii.gz` input is read as gzipped NIfTI; ANTs picks the reader by file name.
A failed run throws an error whose message ends with the last log lines; `error.log` holds the whole log.
A run that exits non-zero leaves the kernel usable.
Some mistakes, such as an input that argv names but `inputs` does not hold, make the kernel abort (trap) instead: the error then has `aborted: true`, and that instance refuses later runs, so load a new one.
The worker does this itself: its next message loads a new kernel.
`run` refuses an `--output` prefix whose directory does not exist before the kernel runs, as ANTs aborts on it.

## Rules

- `run` refuses argv without exactly one `--float 1`, in JavaScript, before the kernel runs. Only `antsRegistration3DFloat` is compiled; `src/unsupported.cxx` (a copy of `packages/registration`'s) refuses 2D, 4D and every double mode, 3D double included.
- `run` refuses argv without exactly one `--random-seed N`, N an integer from 1 to 2147483647. Without it ANTs seeds from the clock. The seed is never taken from the environment: `ENV` is not in `EXPORTED_RUNTIME_METHODS` (only `FS` and `callMain`), so `ANTS_RANDOM_SEED` cannot reach the kernel.
- The kernel uses one ITK thread (`src/main.cxx`), so results do not depend on the host.
- Memory starts at 256 MiB (`INITIAL_MEMORY=268435456`) and grows to at most 4 GiB (`MAXIMUM_MEMORY`), as `packages/registration`: four workers start at about 1 GiB.
- Node and the worker refuse a `.wasm` whose SHA-256 is not `HMC_REGISTRATION_WASM_SHA256` (`src/pin.js`).

## Parity

`test/data` holds a 32³ 2 mm pair of three Gaussian blobs, the moving image moved by (3, −2, 4) mm RAS, both sampled from the formula (`scripts/make-test-data.mjs`).
Native `antsRegistration` built from ANTs 52bc0ab (SuperBuild, Release, `ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1`) and this module, in Node and in a Chromium worker, write the same `out0GenericAffine.mat`, byte for byte, with the argv in `test/expected.mjs` (seed 1234).
Its translation is (−2.994, 2.008, 4.007) mm LPS, the shift within 0.01 mm.
The tests pin that file's SHA-256.
On NiFreeze's own registrations (#446, `validation/nifreeze-replay.mjs`, held to `exes/dwi/hmc/validation/q53-replay.json` in the `dwi-native` workflow), the module writes the same transform as native `--float 1` for 98 of 101 runs; GP volumes 31, 52 and 88 differ by at most 0.03 mm.
A run takes about 0.5 s in Node.

One instance aborts on its 27th run, whatever the input ([#537](https://github.com/neurodesk/webapps/issues/537)), so load a new one before that (the replay loads one every 20 runs).
`src/main.cxx` registers ITK's IO factories in every `main()`, and ITK does not drop duplicate statically linked factories; that is the likely cause.

## Tests

```bash
pnpm --filter @neurodesk/hmc-registration test          # Node
pnpm --filter @neurodesk/hmc-registration test:browser  # Chromium module worker
```

`test:browser` needs a Playwright Chromium (`node node_modules/@playwright/test/cli.js install chromium`).
CI runs `test` in `pnpm test:packages` and `test:browser` in `.github/workflows/hmc-registration.yml`.

## Rebuild

Docker, curl and tar are required:

```bash
bash packages/hmc-registration/scripts/build.sh /var/tmp/hmc-registration-build
```

The script downloads ANTs at `52bc0ab588102682587303d31c720de94e6ef6c1` and compiles in `itkwasm/emscripten@sha256:d6c35290a9f1c5cfeb8168c18bbf64d78394cd111b6a19c6091921e98a3aaa1d`, one job, with an 8 GB container limit (`HMC_REGISTRATION_BUILD_MEMORY`).
`SOURCE_DATE_EPOCH` fixes the `__DATE__` and `__TIME__` that `ANTsVersion.cxx` embeds at the ANTs commit time, so the build is reproducible: two builds from empty directories wrote the same `.wasm` (11 513 576 bytes, SHA-256 `1279b089…`).
A build took about 2 minutes and the container peaked near 1.6 GiB.
When a source or the toolchain changes, put the printed SHA-256 in `src/pin.js`.

# @neurodesk/hmc

DWI head-motion correction for the `hmc` web app and command line: a pool of `@neurodesk/hmc-registration` kernels that registers each volume to a target, one resampling of the series with the per-volume transforms, and the BIDS-derivative outputs.
It also holds `src/hmc.wasm`, the WebAssembly build of the `exes/dwi/hmc` crate (`exes/dwi/hmc-wasm`): ITK `.mat` files, motion parameters and the motion TSV, b-vector rotation and NiFreeze's `advanced_clip`.

This package has no estimator loop. The caller gives the target of each volume (a b0 template, a model prediction) and the registration argv. The NiFreeze loop (#450) and SHORELine (#458) use it.

## Use

In Node:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { correctHeadMotion, readSeries } from '@neurodesk/hmc';
import { loadHmcNode, nodeRuntime } from '@neurodesk/hmc/node';

const { files } = await correctHeadMotion({
  series: await readSeries(await readFile('sub-01_dwi.nii.gz')),
  bvals, bvecs,                                 // [b...], [[x...], [y...], [z...]]
  method: 'nifreeze',                           // or 'shoreline'
  target: (volume, b0) => (b0 ? null : template), // Float32Array on the series grid; null: keep the volume
  argv: (volume) => argv,                       // antsRegistration argv: fixed.nii, moving.nii, mask.nii, --output [out]
  mask,                                         // Uint8Array, one byte per voxel, or null
  fileName: 'sub-01_dwi.nii.gz',
  sidecar,                                      // the input's JSON sidecar, or null
  hmc: await loadHmcNode(),
  runtime: nodeRuntime({ workers: 4 }),
  signal,                                       // AbortSignal
  onProgress: ({ stage, volume, done, total }) => {},
});
for (const [name, bytes] of Object.entries(files)) await writeFile(name, bytes);
```

In a browser, inject the kernel's module worker and CompressionStream:

```js
import { correctHeadMotion } from '@neurodesk/hmc';
import { browserRuntime, loadHmcBrowser } from '@neurodesk/hmc/browser';

const runtime = browserRuntime({ workerUrl: new URL('@neurodesk/hmc-registration/worker', import.meta.url), workers: 4 });
const hmc = await loadHmcBrowser(new URL('@neurodesk/hmc/hmc.wasm', import.meta.url));
```

The kernel is linked with `-pthread`: the page must be cross-origin isolated.

## Pool

- Each worker holds one `@neurodesk/hmc-registration` kernel, which starts at the `INITIAL_MEMORY` of its build (256 MiB). The caller sets the worker count, and so the memory: 4 workers start at about 1 GiB.
- The workers speak the kernel worker's protocol, `{ id, argv, inputs }` to `{ id, outputs, log }` or `{ id, error, log }`. In a browser that is `@neurodesk/hmc-registration/worker`; in Node, `src/node-worker.js` on a worker thread.
- The NIfTI inputs of a volume are made when a worker is free, and moved (transferred) to it.
- Cancellation: the pool checks the `AbortSignal` before it sends each run. An abort terminates every worker at once, the run in progress included, and frees their memory; `correctHeadMotion` rejects with the signal's reason (`AbortError`).
- Progress: `onProgress({ stage, volume, done, total })` after each registration (`register`) and each resampling (`resample`) of a volume, then `write` (`done` 0, then 1).
- A volume's result depends only on its inputs and argv, and the results are put in volume order. The kernel uses one ITK thread, and it refuses an `antsRegistration` argv without `--random-seed`. The package does not set the seed: give the same `--random-seed` in `argv` to get the same bytes with any worker count. The tests (seed 1234) show that 1 and 4 workers write the same bytes.

## Outputs

`src/outputs.js` makes the names with the shared module of the DWI apps, `@neurodesk/webapp-components/file-io/bids-derivatives` (#413), so they have the form of the degibbs, dwidenoise, n4 and noddi outputs. Two rules are hmc's own: a path keeps only its file name, and a name without a suffix becomes `dwi`. For `sub-01_dwi.nii.gz`:

| File | Content |
| --- | --- |
| `sub-01_desc-hmc_dwi.nii.gz` | the corrected series, float32, every volume (b0 volumes kept, Q51) |
| `sub-01_desc-hmc_dwi.bval`, `.bvec` | every column: NiFreeze `%.2f` and `%.6f`, SHORELine `%i` and `%.8f` (`exes/dwi/hmc/src/bvec.rs`) |
| `sub-01_desc-hmc_motion.tsv` | `trans_x trans_y trans_z rot_x rot_y rot_z framewise_displacement` (SHORELine adds `scale_x scale_y scale_z`), one row per volume, RAS+, QSIPrep's formula on the series grid |
| `sub-01_desc-hmc_dwi.json` | the input's sidecar with `Description` and `HeadMotionCorrection`, no time or host |
| `sub-01_vol-0003_desc-hmc_xfm.mat` | the ITK transform of volume 3 (0-based), as antsRegistration wrote it; an identity transform for a volume that was not registered |

The shared module has no rule for per-volume files, so the motion table and transform names are hmc's own. They use the same source entities and `desc-hmc`.

## Resampling

Each registered volume is resampled once, by `--apply volume.nii volume.nii resampled.nii BSpline 0 transform.mat`: the forward transform (fixed to moving), on the series grid, fill 0.
A volume whose target is `null` (the b0 volumes in the NiFreeze path) is copied unchanged, not resampled through an identity transform.

NiFreeze 3bcfb00 resamples with `nitransforms.resampling.apply(..., order=3)`, a SciPy cubic spline (#534's README). `BSpline` (order 3) is the closest `--apply` interpolator.
`validation/nifreeze_resampling.py` applies NiFreeze's steps (`ITKLinearTransform.to_ras`, `apply(order=3)`, nitransforms 25.1.0, SciPy 1.16.2) to the same `.mat` files of the synthetic series (`validation/export-synthetic.mjs`). The largest difference, relative to the peak of the volume:

| Voxels | Largest difference | Mean difference |
| --- | --- | --- |
| at least 3 voxels from every face | 9.4e-8 | 4.0e-9 |
| all, faces included | 8.2e-3 | - |

Inside the grid the two agree to float precision. At the faces they differ, because SciPy pads with 0 (`mode="constant"`) and ITK's B-spline mirrors the image.
NiFreeze also casts the output back to the input type; this package writes float32.

## Module

`src/wasm.js` (`loadHmc`) drives the C ABI of `src/hmc.wasm`, as `packages/noddi` does: no wasm-bindgen.

| Function | Port |
| --- | --- |
| `readMat`, `writeMat` | ITK `.mat` (MATLAB v4), float or double |
| `motionParams`, `motionTsv` | QSIPrep 26.1.1 `get_ras_motion_params`, nipype framewise displacement |
| `b0Flags`, `rotateGradients` | the b0 and b-vector rules of NiFreeze 3bcfb00 and SHORELine (QSIPrep 26.1.1) |
| `advancedClipInPlace`, `advancedClip` | NiFreeze `advanced_clip`, with its in-place state (Q55): float volumes are overwritten, integer volumes are not |

## Tests

```bash
pnpm --filter @neurodesk/hmc test
```

`test/pipeline.test.js` runs the pool on worker threads with the real kernel on a synthetic series (`test/synthetic.js`): 32³, 2 mm, six volumes (two b0 volumes, three moved DWI volumes with known shifts up to 5.4 mm and one 4° rotation, and one DWI volume that does not move), sampled from a formula after each motion. The registration argv is not NiFreeze's: mean squares on every voxel, which finds this motion to 0.06 mm and 0.06°.
The test checks the transforms (0.1 mm, 0.1°), the names, the columns, the b0 volumes, byte-identical outputs with 1 and 4 workers, and that a cancel stops the pool within one volume with every worker thread ended.

## Rebuild the module

```bash
pnpm --filter @neurodesk/hmc build:wasm   # rebuild src/hmc.wasm
pnpm --filter @neurodesk/hmc check:wasm   # rebuild and compare byte for byte
```

Rust 1.98.0 with the `wasm32-unknown-unknown` target and binaryen `version_117` `wasm-opt` are required. `.github/workflows/dwi-native.yml` (`wasm-source`) runs the check.

# @neurodesk/dwidenoise

Patch2Self denoising of diffusion MRI (Fadnavis et al. 2020) for the `dwidenoise` web app and its command line.
The numerical code is the Rust crate [`exes/dwi/denoise`](../../exes/dwi/denoise), a port of DIPY 1.12.1 `patch2self` version 1 (patch radius 0, `model="ols"`), compiled to `src/dwidenoise.wasm`.
The port does not copy DIPY 1.12.1's `copy_X=False` defect in version 1 ([dipy/dipy#3967](https://github.com/dipy/dipy/issues/3967), fixed by [dipy/dipy#3976](https://github.com/dipy/dipy/pull/3976) and not yet released); see the crate's README.
It is BSD-3-Clause, as the DIPY source is.
The crate's README gives the method, the choices and why version 1 is used.

## Use

```js
import { loadDwidenoise } from '@neurodesk/dwidenoise';

const p2s = await loadDwidenoise(fetch(new URL('@neurodesk/dwidenoise/wasm', import.meta.url)));
const buffer = p2s.allocate(nvox * bvals.length);
buffer.view().set(volumes); // or decode the NIfTI straight into buffer.view()
p2s.denoise(buffer, nvox, bvals, { onProgress: (done, total) => {} });
const denoised = buffer.view();
buffer.free();
```

Data is volume-major Float32, as in NIfTI.
`allocate` puts it in the module's memory, and `denoise` works there in place, so the page holds one copy.
Call `view()` again after other calls: when the module's memory grows, earlier views detach.
`denoiseArray(data, nvox, bvals)` returns a denoised copy instead.

For workers, `accumulate(buffer, nvox, group, gram, first, count)` adds a voxel range to a group's Float64 Gram matrix, and the Gram matrices of separate ranges add element by element.
`solve(gram, group)` makes the coefficients, and `apply(buffer, nvox, group, coefficients, first, count)` replaces a range with its predictions.
`solveVolume(gram, group, j)` makes row `j` of `solve` (the same values, bit for bit): one Cholesky solve, so a worker can solve one volume per message and the page can stop or report progress between volumes.
`denoiseChunks(data, nvox, bvals, { chunk })` is the web app's worker schedule in one thread: chunks of `CHUNK_VOXELS` voxels, partial Gram sums added in chunk order, one `solveVolume` per volume, then the predictions of each chunk.
The app's output equals it bit for bit.
`fittedGroups(bvals)` gives the groups to fit: the b0 volumes (b < 50 s/mm², `B0_THRESHOLD` from the module) when there are two or more, and the diffusion-weighted volumes.

## Parity

The WASM output of the ds005134 slab (67 × 92 × 10 × 137) equals the stage 1 DIPY reference (`dwidenoise/validation` in the dataset, float32) bit for bit.
`scripts/check-slab.mjs INPUT.nii.gz INPUT.bval REFERENCE.nii.gz` repeats the check and times the two passes.
`--app OUTPUT.nii.gz ...` also runs `denoiseChunks` and fails unless each downloaded app output has the same float32 bits.
On the slab, the outputs of the app before and after the worker solve (#428) both pass, and `denoiseChunks` also equals the DIPY reference bit for bit.
In Node 22 on the development host, the Gram pass did about 0.5 million voxels per second and the apply pass about 0.24 million voxels per second (both groups, 137 volumes).

## Memory and responsiveness of the app

The app (#428) solves each volume in a worker, writes the workers' results straight into the output NIfTI (`allocateNifti` from `@neurodesk/webapp-components/file-io`), finds `cal_max` in the workers, and compresses the output in a worker that receives the buffer without a copy.
Before, the page solved each group on its own thread, held the result and a second copy for the NIfTI writer, wrote 127 M values one at a time, and compressed through a `Blob` copy on its own thread.

Measured on the full-brain ds005134 sub-01 DWI (`sub-01_dir-AP_run-001_dwi`, 116 × 116 × 69 × 137, int16, 81 MB gzipped, 509 MB as Float32), from the Denoise click to "Denoised", in Playwright's headless Chromium (1.64) on the 8-core Linux development host:

| | Before | After |
| --- | --- | --- |
| Peak RSS of the page's renderer process (workers included) | 3475 MB | 3011 MB |
| Peak sum of RSS of all browser processes (sampled every 25 ms) | 4315 MB | 3879 MB |
| Longest main-thread task | 9040 ms | 169 ms |
| Time | 19.5 s | 17.6 s |

Each browser was started with Playwright's `launchServer`; the renderer peak is `VmHWM` in `/proc/<pid>/status`, read after the run, with `clear_refs` reset to 5 when the image was loaded, and the sum is the largest total of `VmRSS` over the browser's processes, sampled every 25 ms.
The peaks change by about 100 MB from run to run (two runs before: 3376 and 3475 MB; two after: 3022 and 3011 MB).
The output NIfTI was the same in both runs (sha256 `2127198e4f66a1c6eff7342a35a2214aa668dde6d97cd7cd6676e0615e98ddbd`).
The peak now comes when the viewer reads the denoised image, while the page still holds the input (509 MB) for another run.
Before, most of the 9 s task was gzip on the page's thread.

## Build

The module is committed. After a change to `exes/dwi/denoise` or `exes/dwi/denoise-wasm`, run `pnpm --filter @neurodesk/dwidenoise build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).

# @neurodesk/sdc

Reverse phase-encoding susceptibility distortion correction for the `sdc` web app.
The numerical code is the Rust workspace [`exes/sdc`](../../exes/sdc), a port of PyHySCO 0.0.4, compiled to `src/sdc.wasm`.
It is GPL-3.0-or-later, as PyHySCO is GPL-3.0.

## Use

```js
import { loadSdc } from '@neurodesk/sdc';

const { pyhysco } = await loadSdc(fetch(new URL('@neurodesk/sdc/wasm', import.meta.url)));
const { field, corrected1, corrected2 } = pyhysco(ap, pa, [nx, ny, nz], voxel, {
  phaseEncodingDirection: 'j-',
  totalReadoutTime: 0.038,
});
```

`ap` and `pa` are Float64Array volumes, first index fastest, with opposite phase-encoding directions and in one space.
`field` is in Hz with FSL topup's sign: image 1 corrected is image1(x + field · TotalReadoutTime · sign) voxels along the phase-encoding axis.

`estimate` takes the same arguments and returns a promise of the same result, with `backend` set to `"webgpu"` or `"cpu"`:

```js
const { estimate } = await loadSdc(fetch(new URL('@neurodesk/sdc/wasm', import.meta.url)));
const { field, backend, gpuError } = await estimate(ap, pa, [nx, ny, nz], voxel, options);
```

`options.backend` is `"auto"` (the default), `"webgpu"` or `"cpu"`.
`auto` runs the Gauss-Newton evaluations and the CG solves on WebGPU (`src/webgpu.js`) when the browser has a hardware adapter and JSPI (`WebAssembly.Suspending`).
Otherwise, or when the WebGPU run fails, it runs the CPU path and gives the reason in `gpuError`.
`webgpu` also accepts a software adapter, or the device in `options.device`, and fails instead of falling back.
The WebGPU path computes in float32. Its field agrees with the native PyHySCO field to a median of 1.9e-5 Hz in the brain on ds005134 sub-01 ([measurements](../../exes/sdc/README.md#webgpu)).

## Parity

See [`exes/sdc`](../../exes/sdc/README.md#parity).

## Build

The module is committed. After a change to `exes/sdc/core` or `exes/sdc/wasm`, run `pnpm --filter @neurodesk/sdc build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).

# @neurodesk/degibbs

Gibbs-ringing removal by local subvoxel shifts (Kellner et al. 2016) for the `degibbs` web app and its command line.
The numerical code is the Rust crate [`exes/dwi/degibbs`](../../exes/dwi/degibbs), a port of MRtrix3 3.0.8 `mrdegibbs`, compiled to `src/degibbs.wasm`.
It is MPL-2.0, as the MRtrix source is.

## Use

```js
import { loadDegibbs, sliceAxes } from '@neurodesk/degibbs';

const { degibbs } = await loadDegibbs(fetch(new URL('@neurodesk/degibbs/wasm', import.meta.url)));
const fixed = degibbs(volume, [nx, ny, nz], 1, { axes: sliceAxes(sidecar.SliceEncodingDirection) });
```

The options and their defaults are those of `mrdegibbs`: `nshifts` 20, `minW` 1, `maxW` 3, and in-plane axes `[0, 1]` unless the sidecar's `SliceEncodingDirection` names another slice axis.

## Parity

On the first 10 volumes of OpenNeuro ds005577 sub-107 (120 × 120 × 75, full Fourier), the port equals MRtrix 3.0.8 `mrdegibbs` to 2.3e-14; `mrdegibbs` changes the input by 6.6 % (NRMSE).

## Build

The module is committed. After a change to `exes/dwi/degibbs` or `exes/dwi/degibbs-wasm`, run `pnpm --filter @neurodesk/degibbs build:wasm`.
`check:wasm` fails when a rebuild does not give the committed bytes (Rust 1.98.0, binaryen `version_117`).

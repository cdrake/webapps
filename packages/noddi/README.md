# @neurodesk/noddi

Diffusion tensor and NODDI fitting for the `noddi` web app and its command line.
The numerical code is the Rust workspace in [`exes/dwi`](../../exes/dwi), compiled to one WebAssembly module, `src/noddi.wasm`.
The design is in [the diffusion microstructure design](../../docs/architecture/dwi-microstructure-design.md).

## Use

```js
import { loadNoddi } from '@neurodesk/noddi';

const noddi = await loadNoddi(fetch(new URL('@neurodesk/noddi/wasm', import.meta.url)));
const table = noddi.describe(bvals, bvecs);
// table.shells, table.dtiVolumes, table.noddiError (null when NODDI can run)
const maps = noddi.dtiFit(data, voxels, bvals, bvecs, { mask });
// maps.FA, maps.MD, maps.AD, maps.RD, maps.S0, maps.V1x, maps.V1y, maps.V1z
```

```js
const model = noddi.noddiModel(bvals, bvecs); // throws when NODDI cannot run
const out = model.fit(chunk, chunkVoxels, chunkMask);
// out.ICVF, out.ISOVF, out.OD, out.dirx, out.diry, out.dirz
model.free();
```

`data` is a Float32Array with the volumes one after the other, as `readNiftiFrames` returns them.
`model.fit` takes the same layout for a chunk of voxels, so a caller can report progress or spread chunks over workers.
NODDI is a port of AMICO 1.5.4; [exes/dwi/amico](../../exes/dwi/amico/README.md) describes it and its parity with AMICO.
`bvecs` is three rows (x, y, z) with one value per volume, as in an FSL `.bvec` file.

## Rules

- A volume with b < 50 s/mm² is a b0.
- Shells are the non-zero b-values rounded to the nearest 100 s/mm².
- The tensor fit uses the b0 volumes and the lowest shell.
- NODDI needs two or more shells.

## Tensor fit

The weighted fit uses the squared observed signal as weights, as FSL `dtifit -w` does.
On the dwi2trx example, the FA and MD maps equal FSL 6.0.7.23 `dtifit -w` in the median voxel (FA difference 1.5e-8).
Voxels with a non-positive sample, and CSF voxels at the noise floor, differ: FSL treats those samples in a way that is not documented.
A non-positive sample takes the smallest positive sample of its voxel.

## Build

The module is committed. After a change to `exes/dwi`, run:

```bash
pnpm --filter @neurodesk/noddi build:wasm
pnpm --filter @neurodesk/noddi check:wasm
```

The build needs Rust 1.98.0 with the `wasm32-unknown-unknown` target and binaryen `version_117` `wasm-opt`.
`check:wasm` fails when a rebuild does not give the committed bytes.

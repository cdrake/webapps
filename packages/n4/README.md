# @neurodesk/n4

ANTs N4BiasFieldCorrection compiled to WebAssembly, for the `n4` web app and its command line, with the DWI procedure of MRtrix `dwibiascorrect ants`.
It is a separate module from `@neurodesk/registration`, at the same pinned ANTs commit and ITK-Wasm toolchain, so the SYNcro and ANTs kernels do not change.

## Use

```js
import { createN4, rescaleBias, divideVolumes } from '@neurodesk/n4';
import createModule from '@neurodesk/n4/module';

const n4 = await createN4({ createModule, wasmBinary });
const { corrected, bias } = await n4.correct({ image: meanB0Nifti, weight: maskNifti });
```

`correct` runs `N4BiasFieldCorrection -d 3 -i IN -w WEIGHT -o [CORRECTED,BIAS] -s 4 -b [100,3] -c [1000,0.0]`, the `dwibiascorrect ants` defaults, and returns NIfTI bytes.
For a DWI series, `rescaleBias` keeps the brain integral as `dwibiascorrect` does, and `divideVolumes` corrects every volume.
Run it in a worker: N4 is synchronous.

## Parity

On the mean b0 of the ds005134 sub-01 example slab, weighted by the app's default MindGrab mask (45 965 voxels), the module's bias field and corrected image equal native ANTs 2.6.5 `N4BiasFieldCorrection` (Neurodesk container `ants_2.6.5_20261012`, one thread, dwibiascorrect's options) byte for byte. It takes about 3 s in Node.
The reference is pinned on Hugging Face (`n4/validation/ds005134-sub-01-slab/`, its README gives every command) by `validation/reference.json`; `test/native-reference.test.js` checks the exact equality in the `dwi-native` workflow:

```sh
export $(node validation/fetch-reference.mjs /var/tmp/n4-reference)
N4_REQUIRE_REFERENCE=1 node --test test/*.test.js
```

An earlier hand check with an FSL `bet -f 0.3` mask (44 521 voxels) was also exact.

## Rebuild

Docker, curl and tar are required:

```bash
bash packages/n4/scripts/build.sh /var/tmp/n4-build          # rebuild and copy into wasm/
bash packages/n4/scripts/build.sh --check /var/tmp/n4-build  # rebuild and compare with wasm/
```

The script downloads ANTs at `52bc0ab588102682587303d31c720de94e6ef6c1` and compiles in `itkwasm/emscripten@sha256:d6c35290…`, one job, with an 8 GB container limit (`N4_BUILD_MEMORY`).

The build is byte-reproducible: a rebuild gives the committed `n4-bias.wasm` and `n4-bias.mjs` byte for byte.
The `n4-wasm-source` workflow runs `--check` each week and by hand (Actions, "Run workflow"); it fails when either file differs and keeps the rebuilt files as the `n4-rebuilt` artifact.
The one cause of difference was ANTs' `ANTsVersion.cxx`, which compiles in `__DATE__ " " __TIME__`.
The script sets `SOURCE_DATE_EPOCH=1792348789` (Oct 18 2026 18:39:49 UTC, when the committed module was built), which Clang uses for both macros.
The sources and the build tree are mounted at the same container paths on every host, and the build tree starts empty each time, so the host and the directory do not change the bytes.

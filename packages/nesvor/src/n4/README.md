# N4 bias correction

This module runs ITK's `N4BiasFieldCorrectionImageFilter` in WebAssembly. It preserves NeSVoR v0.5.0's image array order and reversed spacing assignment, `[gap, resolution_y, resolution_x]`. Shrinking applies to the image and mask together. The fitted B-spline control lattice reconstructs the full-resolution log bias field before division.

The public API is `createN4Corrector(module)`, where `module` is the initialized generated `nesvor-n4.mjs` Emscripten module. The returned function accepts `{ data, mask, shape, resolution }` and optional settings. Dimensions are `[x,y,z]`, x varies fastest, and resolution is `[resolution_x,resolution_y,gap]`. Returned intensities occupy a new `Float32Array`. Call it inside the reconstruction worker; terminating that worker cancels computation.

Absent masks become an all-ones mask. This fixes an upstream Python local-variable error when no mask is supplied, while preserving N4's all-voxel mask semantics. Positive mask labels normalize to one, matching NeSVoR's boolean stack masks.

Build outside the repository:

```sh
bash packages/nesvor/native-n4/build.sh "$TMPDIR/nesvor-n4-build"
```

The build uses the same digest-pinned ITK Emscripten image as the registration package. Keep the generated `.mjs`, `.wasm` and worker helpers together when staging. The threaded ITK build requires cross-origin isolation, although N4 itself uses one ITK thread.

Generate independent fixtures by invoking the actual pinned upstream function with SimpleITK, then run the compiled WASM kernel against them:

```sh
python packages/nesvor/src/n4/export-oracle.py \
  --upstream "$TMPDIR/nesvor-source" --output "$TMPDIR/nesvor-n4-oracle"
node packages/nesvor/src/n4/verify-oracle.mjs \
  "$TMPDIR/nesvor-n4-build" "$TMPDIR/nesvor-n4-oracle"
```

The fixture covers anisotropic spacing, a nontrivial mask, and both direct correction and shrink/full-resolution reconstruction. The short iteration schedule tests numerical agreement, not correction quality or clinical validity.

Validated with ITK 5.4.6 compiled by the pinned toolchain and SimpleITK 2.5.6. Chromium 149.0.7827.55 and Node 24 both produced identical direct-correction results and a maximum absolute error of 0.0000152587890625 for the two shrink cases. The oracle gate is 0.0001 absolute error and 0.00001 RMSE. Generated inputs and outputs remain outside the repository.

To rerun in Chromium:

```sh
PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/playwright" node packages/nesvor/src/n4/verify-browser.mjs \
  "$TMPDIR/nesvor-n4-build" "$TMPDIR/nesvor-n4-oracle"
```

`manifest.json` pins the published runtime by Hugging Face commit and SHA-256. `scripts/stage-nesvor-runtime.mjs` stages both files under the app's `public/n4/` from `NESVOR_N4_DIR`, or downloads them into the external `TMPDIR` cache. Every local or downloaded asset must match the manifest.

The asynchronous browser loader is `createN4Corrector({ baseUrl, manifest, signal, onProgress })` from `loader.js`. It verifies the staged module and WASM with the shared `fetchModel` helper, initializes the module with the verified WASM bytes, and returns the synchronous correction function. `baseUrl` must be the same-origin `n4/` directory, with cross-origin isolation enabled. Loading the generated module at its real URL preserves its relative pthread module URL.

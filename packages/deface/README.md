# @neurodesk/deface

The Deface pipeline, shared by the Deface web app and the `deface` command line.
`src/pipeline.js` builds every niimath argv and the MindGrab call; the app and the
command line inject their own runtimes, so both run the same commands on the same
WebAssembly and write the same files.

## Command line

`deface` removes the face from one NIfTI image on the CPU and writes
`defaced.nii`, the file the web app downloads, on the input's grid and datatype:

```sh
deface head.nii.gz results                              # allineate (fast)
deface head.nii.gz results --method allineate_hel       # exhaustive Hellinger
deface head.nii.gz results --method mindgrab8           # MindGrab, 8 mm border
deface download-models                                  # MNI template and face mask, once
deface self-check
```

| Method | What it runs |
| --- | --- |
| `allineate` (default) | niimath registers the MNI template to the image and zeroes the voxels under its face mask (`-deface`, fast engine) |
| `allineate_robustfov` | the same after a `-robustfov` neck crop |
| `allineate_hel`, `allineate_hel_robustfov` | the exhaustive Hellinger engine (`-cost hel`); minutes on a full head |
| `mindgrab`, `mindgrab_robust` | MindGrab brain extraction, then the image times the brain mask |
| `mindgrab8`, `mindgrab_robust8` | the same with the mask grown by 8 mm (`-close 1 8 0`) |

The MindGrab methods also write `brain-mask.nii`, the mask the image was
multiplied by. A robustfov method writes the cropped grid. `--cache-dir DIR` and
`--offline` choose the template directory and forbid downloads. The output
directory must be new or empty. The command prints a JSON report with the
provenance, including the template checksums or the MindGrab version and backend.

niimath runs the frozen BSD-2 WebAssembly build the app uses
(`@neurodesk/runtime-support/niimath`), one fresh module per command through
`@neurodesk/node-drivers/niimath`. MindGrab runs `@brainchop/mindgrab`'s threaded
CPU module through `@neurodesk/node-drivers/mindgrab`: about 50 s and 2.6 GB on the
1 mm example with 16 cores. Its weights are compiled into the module, so only the
MNI template (554 KB) and face mask (7 KB) are downloaded, pinned by
`model.manifest.json` and checked by SHA-256 on every load. DICOM input needs the
web app.

## MindGrab

The app used to run MindGrab from its own copy of the model: tinygrad-generated
WebGPU shaders that needed `shader-f16`, NiiVue's conform worker and a min-max
intensity normalisation, then niimath `-reslice_nn` back to the input grid. Its
`net_mindgrab.safetensors` holds the same 27 float32 tensors, byte for byte, as
the weights compiled into `@brainchop/mindgrab` 0.1.20260925 (25 MeshNet layers
of 15 channels and the 2-class head). The app now runs the package itself, through
the shared browser runtime `@neurodesk/runtime-support/mindgrab`: the package's
conform, normalisation, largest-component cleanup and reslice, on a hardware GPU
when there is one and on the threaded CPU module otherwise. The command line runs
that CPU module. The brain extraction app and Brain2Print run the same package.

## Validation

`validation/browser-reference.mjs` builds `validation/harness/` with Vite and runs
the app's pipeline and browser runtimes in Chromium on the app's example
(`apps/deface/examples.json`), with MindGrab on its CPU backend. It records each
file's SHA-256 in `browser-reference.json`. Each MindGrab mask is packed to one
bit per voxel and stored at a commit-pinned Hugging Face URL there, with its
SHA-256 and byte size. Both validators cache these masks outside the source
repository and verify them on every read. `--check` reruns the browser pipeline
and fails on any difference. `.github/workflows/deface-native.yml` does that
before packaging.

After changing the pipeline or its runtimes, record with
`node validation/browser-reference.mjs --output /storage/path/references`.
The mask output directory must be outside the source repository. Upload changed
masks to `neurodeskorg/webapps`, then pin their dataset commit URLs, checksums and
sizes in `browser-reference.json`. Keep only the JSON and recording code in Git.

`validation/cli-check.mjs --executable PATH` holds a command line to that run:
niimath's `defaced.nii` must be the browser's byte for byte; a MindGrab mask must
reach Dice 0.99 with the browser's, and when it is identical, so must the defaced
image. On linux-x64 every file was identical. Hellinger is not a release case: it
differs from the fast engine only by `-cost hel` and takes minutes.

The portable archives are built by `exes/node-cli` for Linux x64, Windows x64 and
macOS arm64, and each must pass the check.

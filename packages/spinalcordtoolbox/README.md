# Spinal Cord Toolbox web app segmentation

The segmentation behind the Spinal Cord Toolbox web app, shared by its browser
worker and the portable `sct-webapp` command line: task preprocessing
(reorientation, resampling, axis order), sliding-window ONNX inference,
TotalSpineSeg disc labelling, SCIseg/MS lesion masks and the approximate lesion
metrics. `src/segment.js` never fetches, caches or touches a browser global; the
worker (`apps/spinalcordtoolbox/web/js/inference-worker.js`) supplies ONNX
Runtime Web and verified downloads, `src/node.js` supplies ONNX Runtime's native
CPU backend and model files.

## Command line

Download a portable archive from the app's Standalone action, extract it and run
it locally. The macOS installer puts `sct-webapp` on PATH.

```sh
sct-webapp self-check
sct-webapp segment --task spinalcord t2.nii.gz results
sct-webapp download-models --task lesion_ms
sct-webapp segment --task lesion_ms t2_ms.nii.gz ms-results --threshold 0.3
sct-webapp tasks
```

Tasks are the web app's runnable ones: `spinalcord` (the default), `graymatter`,
`lesion_sci_t2`, `lesion_ms` and `spine` (TotalSpineSeg). `--threshold`,
`--minimum-component-size` and `--test-time-augmentation` follow the automation
contract; omitted values use each model's defaults, as the app does. The output
directory must be new or empty. It uses the app's output formats and names:
`<task>_<stage>.nii` for every mask (`spinalcord_segmentation.nii`,
`lesion_sci_t2_lesion.nii`, `spine_spine_discs.nii`, ...) in the input's grid,
and `<task>_lesion_metrics.csv` for lesion tasks. A JSON report with voxel counts,
lesion summaries and provenance goes to standard output.

### Models

The five models total about 1.35 GB, so a release carries only the `spinalcord`
model (123 MB). `sct-webapp download-models --task TASK` (repeatable, or `--all`)
fetches another task's model from its pinned Hugging Face revision
(`sbollmann/sct-webapp-data`) into `--cache-dir`, by default
`~/.cache/neurodesk/sct-webapp`. Every model is checked against the size and
SHA-256 in `model.manifest.json` when it is downloaded and again each time it is
loaded; a mismatch is an error, never a silent re-download.

`segment` downloads a missing model itself unless it runs offline: `--offline` or
`NEURODESK_OFFLINE=1`, which the portable launcher always sets so that an analysis
never reaches the network unasked. Run `download-models` once while online.

### Name

The command is `sct-webapp`, not `spinalcordtoolbox` or an `sct_*` name. Native
SCT installs `sct_deepseg` and the other `sct_*` commands; this tool runs the web
app's converted subset of SCT models, so its name says which one it is and cannot
shadow or be mistaken for an SCT command on the same PATH.

## Task inventory

`model.manifest.json` is a byte-identical copy of the app's
`web/models/manifest.json` (the test suite enforces it); `src/tasks.js` derives the
same run settings as the app's `runSegmentation()`. After changing a task in
`apps/spinalcordtoolbox/web/js/app/sct-tasks.js`, regenerate the app manifest and
copy it here.

## Validation

`validation/cli-check.mjs --executable PATH` runs the release on three pinned SCT
cases: the T2 spinal cord fixture (bundled model), SCT's fake-lesion image with
SCIsegV2, and the SCT course MS image with `lesion_ms`. Each mask must pass the
web app's parity gates against SCT's own output
(`apps/spinalcordtoolbox/scripts/parity-gates.cjs`: Dice, foreground, lesion count
within one and total volume within 20 % for MS). Each download must also match
the app's worker byte for byte when adapted to Node on the same ONNX Runtime
CPU 1.29.0 backend. The check refuses a tampered model, a missing model offline,
an unsupported task and an out-of-range threshold.

The production browser uses ONNX Runtime Web 1.21.0 with its WebAssembly
backend. It shares the pipeline and output formats, but its masks and lesion
tables are not guaranteed byte-identical to the native CPU results. A production
Chromium check of those three public cases passed the unchanged SCT scientific
gates. Browser/native mask comparisons were:

| Case and mask | Differing voxels | Dice |
| --- | ---: | ---: |
| T2 spinal cord | 5 | 0.999894 |
| SCIseg spinal cord | 9 | 0.999377 |
| SCIseg lesion | 1 | 0.997230 |
| MS lesion | 2 | 0.994118 |

The NIfTI headers matched in all four comparisons; both lesion tables differed.
These three cases do not establish cross-backend equality for every task or
option.

## Licensing

Imported application source and converted SCT model weights keep their
NOASSERTION status; this package is UNLICENSED, not newly licensed. See `NOTICE`.

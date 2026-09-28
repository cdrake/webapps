# Automation verification

Build the browser runtime and run the default checks:

```sh
pnpm --filter calmar build
pnpm --filter calmar exec playwright test e2e/automation.spec.js
```

The supplied-lesion test uses the committed 64-voxel lesion on the Yeo 7 atlas
grid and the pinned connectivity pack. Its output must equal the Visual
network's connectivity channel at every voxel. A separate test rejects a mask
with matching dimensions but a shifted affine.

Full structural candidate inference is opt-in:

```sh
CALMAR_AUTOMATION_IMAGE=example \
  pnpm --filter calmar exec playwright test e2e/automation.spec.js --grep 'real structural'
```

`example` downloads the stroke T1 declared in `examples.json` and checks SHA-256
`725a37bf9556c6776a7be552597999df67d175a44eafc03252db058e8f5c5cad`.
Set `CALMAR_AUTOMATION_IMAGE` to a local T1 path to use another image.
Downloads and reports stay under `$TMPDIR/neurodesk-calmar-automation`.
`CALMAR_AUTOMATION_TIMEOUT_MS` sets the inference deadline; the default is ten
minutes. Browser diagnostics are saved beside the reports and attached to the
Playwright result. A renderer failure ends the check immediately.

The candidate check runs the existing SynthStrip, prealignment and SynthStroke
handlers. It checks native-space geometry, binary output and the explicit
unconfirmed review state. It does not measure segmentation accuracy against an
expert lesion annotation. It never confirms a lesion or resumes registration.

The supplied-lesion checks passed on Linux. The full structural run did not
complete there, and candidate inference remains unvalidated. A bounded
90-second diagnostic run completed brain extraction and prealignment, then
reached SynthStroke patch 3 of 27, augmentation 5 of 8, with an estimated 350
seconds remaining. No minimum RAM requirement or cause of the earlier
interrupted run has been established. Run the opt-in check on the target
machine before treating candidate generation as verified there.

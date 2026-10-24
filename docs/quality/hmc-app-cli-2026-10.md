# HMC browser and command-line integration

The browser workspace and `hmc` command line run the shared `correctNiFreeze`
pipeline, with GP as the default and a b0-template option. Registration uses one
worker by default. The worker-count benchmark remains a separate gate; these
workflow runs do not establish performance, memory limits or through-plane
accuracy on a full acquisition.

## Completed checks

The production Chromium build completed both methods on the immutable ds005134
example: 67×92×10 voxels, all 137 volumes, automatic MindGrab CPU masking. Each run
downloaded the corrected float32 NIfTI, b-values, rotated b-vectors, motion TSV,
sidecar and a ZIP containing all 137 ITK transforms. The corrected images were
finite and retained every frame. The input pins and output hashes are in
`packages/hmc/validation/browser-reference.json`. Image hashes cover decompressed
NIfTI bytes; transform hashes cover each extracted file rather than ZIP metadata.

The sidecar records the effective estimator mask after GP eligibility reduction:
SHA-256, byte count and included-voxel count. It also identifies a supplied mask
or the default MindGrab model, version and actual backend. It contains no local
input paths. The dedicated mask worker terminates before registration starts;
the earlier masking peak and the viewer remain outside the registration benchmark.

On a separate synthetic 32³, ten-frame series, both command-line modes wrote
every file byte for byte as an independent invocation of the low-level Node
pipeline. Both production-browser modes also matched that Node invocation:
decompressed image, gradients, motion, sidecar and every transform.

Browser recovery coverage checks a failed pinned-example download followed by a
successful retry, supplied-mask selection, cancellation while registration is
queued, and a successful retry using the retained input and supplied mask. The
downloaded sidecar confirms that the supplied mask was used. Clearing it returns
to automatic masking. This caught and fixed an integration defect: shared
`createFileField` consumers must use `onFiles`, because the component consumes
and clears its native input's file list.

The fresh production reference/parity run passed five tests. The final recovery,
mask-clear and retry run passed two tests. The shared source, catalog, version,
workflow-trigger and immutable-pin checks passed 96 tests. These are correctness
results; wall times observed during concurrent work are not benchmark evidence.

## Reproduce

```bash
pnpm --filter hmc build
pnpm --filter hmc test:e2e
node --test packages/hmc/test/node-files.test.js packages/hmc/test/nifreeze.test.js
node packages/hmc/validation/cli-check.mjs
```

The example browser tests obtain checksummed bytes from the offline asset lock
and route those exact bytes to the example URLs. Playwright blocks service
workers so the COI fallback worker does not bypass its routes; the production
preview supplies the actual COOP/COEP headers. CPU masking and registration run
normally. No simulated scientific output is used.

`HMC_BROWSER_REFERENCE=write` intentionally rerecords the browser reference.
Preserve exported screenshots outside Playwright's default results directory
when running additional tests, since a later invocation clears that directory.

## Portable verification

`packages/hmc/release.json` declares Linux x64, Windows x64 and macOS arm64
packages. `hmc-native.yml` verifies the production browser reference before the
shared portable workflow builds its target matrix. The command's self-check
executes the pinned registration resampler and verifies an identity phantom.

The actual released-version Linux archive check follows the final release and
frozen install. Windows and macOS archive execution requires the remote target
jobs; no local result establishes those platforms. Full interface audits and
the final retained desktop/phone output screenshots follow the final production
build. These gates must be reported separately before claiming full app or
portable acceptance.

# Agent automation work packages

The first supported workflows are brain extraction and SynthSeg. The shared contract,
runner and MCP endpoint must support further apps without app-specific server code.
Existing selector-based jobs remain supported.

## Work packages

- [x] Ground the design in the desktop runner, app lifecycle and production packaging.
- [x] Compare two designs and record the selected public interfaces.
- [x] WP1: Versioned app contracts, validation, job generation and publication beside each pilot app.
- [x] WP2: Shared run state with explicit completion, failure, cancellation and stale-run protection.
- [x] WP3: Structured result reports for brain extraction and SynthSeg, including named artifacts and provenance.
- [x] WP4: Desktop execution from contracts with validated inputs, bounded waits, cancellation and recorded output checksums.
- [x] WP5: Local stdio MCP discovery, validation, execution and artifact resources using the same contracts.
- [x] WP6: Browser and MCP integration checks, documentation, changeset and date-version release.

## Acceptance criteria

An agent can discover either pilot app, validate inputs and parameters, run it,
observe terminal success or the app's error, and read a structured report and
the resulting files. Changing displayed status text cannot break a generated job.
Cancellation cannot leave a successful report, and a previous run cannot complete
a new run. Contract selectors and downloads are checked against built apps.

The desktop tests cover protocol exchanges and runner behavior. Browser checks
exercise the production bundles. Scientific GPU execution is reported separately
from protocol and browser wiring, with hardware limitations stated explicitly.

## Selected design

`packages/desktop/src/main.js` loads a checksummed offline bundle and opens a
sandboxed Electron window. `readJob` resolves uploaded files; `runJob` uses the
page DOM and Electron download events. Two designs were compared: generate
these jobs from app contracts, or introduce a direct page execution API with a
new file transport. The implementation uses generated jobs. This preserves the
existing browser upload/download path and lets each app keep one processing
handler for people and agents. Independent review added isolated run directories,
bounded resource reads and contract checksums to that design.

| Interface | Implementation |
| --- | --- |
| App discovery | `automation.json` and `automation.schema.json` beside each pilot's built page, with the release version stamped by the shared build |
| Invocation | Typed inputs, parameters, engines and artifact roles; strict request validation; `scripts/automation-job.mjs` generates existing schema-1 jobs |
| Browser state | Shared `createRunState`, `#statusText` state/run-ID attributes and `#neurodesk-run` JSON snapshot; published contracts declare the lifecycle selectors and terminal values |
| Results | Shared JSON report with input and output SHA-256 hashes, effective parameters and scientific provenance; SynthSeg browser reports add per-label voxel counts and mL volumes |
| Execution | One active run, a fresh browser window, an overall deadline, cancellation, exact artifact-role matching and report verification before success |
| MCP | Desktop `--mcp` serves discovery, validation, asynchronous execution, cancellation and result resources over stdio; app-specific tools derive their schemas from contracts |
| Native engine | Explicitly configured SynthSeg executable; argument-array invocation, sidecar provenance and bounded termination |

See [the automation guide](../../packages/desktop/AUTOMATION.md) for client
configuration, requests, resource limits and adding another app.

## Verification record

Initial verification on Linux on 2026-09-28:

- Desktop tests: 58 passed, including protocol exchanges, native subprocess
  cancellation, app failures, artifact verification and cancellation during
  success-report publication. Node 24's test isolation hit a serialization error
  in the existing packaging test; the complete suite passed with
  `node --test --test-isolation=none packages/desktop/test/*.test.js`.
- Shared components: 114 tests passed. Selected repository checks for versions,
  app information, theme integration and design-system rules: 40 passed.
- Production app tests: brain extraction passed 8 checks, including the real BET
  golden mask and report downloads; 2 optional model tests were skipped.
  SynthSeg passed 7 checks using a fixture worker for automation behavior.
- `pnpm build` completed all 29 tasks and assembled 27 apps. Both pilot contracts
  match their released app versions. Interface audits, mobile checks and interface
  workflow checks passed for both changed apps. Desktop and phone screenshots
  were reviewed, including the completed BET results and report control.
- `scripts/desktop/automation-smoke.mjs` passed against source Electron and an
  unpacked Linux desktop executable. It discovers both contracts, validates
  requests, runs real BET, reads resources and checks their hashes, checks explicit
  and connection-close cancellation, and checks clean JSON-RPC stdout and exit.
  The mask contained 246875 voxels and matched the existing golden SHA-256
  `107a46c3a2f42f4a7796dc5a5b2a6660a302239ae50a0cf2eea80b1767a50862`.
- The unpacked archive contains the MCP SDK and Zod; all ten packaged source
  modules matched the checkout. This validates an unpacked Linux build, not signed
  release archives for macOS or Windows.
- A changeset generated the release changelogs and versions: desktop
  `0.15.20260928`, brain extraction `0.2.20260928`, SynthSeg `0.4.20260928` and
  shared components `0.5.0`. Dependent apps received date-version updates.
  QSMbly received a minor increment because its existing version already used
  this date. The release command's final lockfile step needed the writable pnpm
  store; rerunning that step and a frozen install succeeded.

After rebasing onto `main` at `5622530`, the unchanged automation patch passed
58 desktop tests, 118 shared-component tests and 33 selected repository checks.
The production build completed all 29 tasks. Both pilot apps passed the updated
interface audit, mobile checks and interface workflow checks. The packaged MCP
smoke passed again with the rebuilt apps, and all ten packaged desktop modules
still matched the rebased source. Desktop and phone screenshots were reviewed.
The desktop and both pilot apps also passed their lint commands.

## Remaining rollout and scientific checks

These six packages deliver the shared implementation and two complete app
integrations. Other catalog apps still need their own contracts, lifecycle calls,
reports and production workflow tests. They are not advertised as MCP tools.
Automation currently accepts one NIfTI file per input; automated DICOM series
selection and viewer crosshair/region/tab control remain separate work.

Real GPU SynthSeg, native SynthSeg numerical parity, and the optional MindGrab
and SynthStrip models were not exercised in this verification. Native adapter
tests use a fixture executable. Native reports retain the CLI sidecar but do not
add the browser's label-volume summary. No change to the SynthSeg GPU ceiling is
included; that needs scientific parity evidence on hardware with larger buffers.

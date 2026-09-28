# Run applications from an agent

Brain extraction and SynthSeg publish `automation.json` beside their built
`index.html`. The contract declares input types, output roles, coordinate spaces,
parameters and selectors. The build stamps the app version and publishes its
JSON Schema as `automation.schema.json`. The desktop verifies the contract's
checksum against its offline inventory before advertising it.

The contract's `lifecycle` declares the status element, JSON snapshot element,
run-ID attribute and terminal state values. These machine-readable signals stay
the same when an app changes its displayed status text.

## Start the MCP server

Launch the desktop executable with `--mcp`. It communicates over stdin and stdout;
it does not open a network MCP endpoint. Diagnostics go to stderr. Browser jobs
still need the GPU and graphical environment described in [STANDALONE.md](STANDALONE.md).

```json
{
  "mcpServers": {
    "neurodesk": {
      "command": "/absolute/path/to/neurodesk-webapps",
      "args": ["--mcp", "--output", "/absolute/path/to/runs"]
    }
  }
}
```

Use the executable inside the `.app` bundle on macOS. For development, run
`electron packages/desktop --mcp` with `NEURODESK_BUNDLE` pointing to an assembled
desktop resource directory. On a Linux server without a display, launch through
`xvfb-run -a`. WebGPU inference still requires a suitable GPU.

The server uses the official [MCP SDK's stdio transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md).
It supports clients using the `2025-11-25` protocol through the SDK's compatibility transport.

## Discover, validate and run

| Tool | Arguments | Result |
| --- | --- | --- |
| `apps.list` | `{}` | Installed contracts and available engines |
| `apps.describe` | `{ "app": "synthseg" }` | One contract |
| `apps.validate` | App and run request | Validated paths, parameters and defaults |
| `runs.start` | App and run request | Run ID and initial state |
| `runs.get` | `{ "runId": "…" }` | State, failure or completed report |
| `runs.cancel` | `{ "runId": "…" }` | Terminal state after cancellation |
| `run_brain_extraction`, `run_synthseg` | Run request | Run ID, with app-specific parameter schemas |

A request to `run_brain_extraction` can contain:

```json
{
  "inputs": { "image": ["/data/head.nii.gz"] },
  "parameters": { "method": "bet", "threshold": 0.5 },
  "engine": "browser",
  "timeoutMs": 1800000
}
```

Each input currently accepts one absolute NIfTI path. The interactive apps also
accept DICOM; automated DICOM-series selection is outside this contract version.
Unknown parameters, invalid values and missing files fail before a run starts.
This validates the invocation; the scientific app validates the image content.

Only one scientific run is active per server. Every run gets a fresh browser
window and output directory. Poll `runs.get` until `state` is `succeeded`, `failed`
or `cancelled`. `phase` distinguishes preparation, processing and export. An error
contains a code and the app's message. The timeout covers preparation through
export. Closing the MCP connection cancels the active run.

SynthSeg's `mode` is `default` or `fast`. Omit `ct` to preserve the browser's
intensity-based detection, or supply a boolean to override it. Brain extraction's
`threshold` applies to BET and `backend` applies to MindGrab; unused controls do
not change the selected method.

## Read results

Completed runs advertise `neurodesk://runs/<runId>/report` and
`neurodesk://runs/<runId>/artifacts/<role>`. Read these through MCP resources.
Resources belong to runs created in the current server session. Each run also
persists `run.json` under the output root, including failed and cancelled runs.
The records and completed files remain available on disk after shutdown.

Reports include the app/version, effective parameters, input hashes, scientific
provenance and named artifacts with byte counts and SHA-256 checksums. Desktop
execution adds the engine, execution ID, contract checksum and output directory.
The downloaded report omits its own checksum; the execution report records it.
The desktop checks the downloaded report and artifacts against the browser's
current run before declaring success. It rechecks artifact hashes on resource reads.

Resource bodies are limited to 64 MiB. For larger files, use the verified local
path from the execution report. Failed or cancelled runs expose no artifact
resources and remove their partial output directory.

SynthSeg's browser report includes FreeSurfer label IDs/names, voxel counts and
volumes in mL. Volumes use the absolute determinant of the output affine and the
NIfTI spatial units. Unknown units omit mL values and include an explanation.
Measurements describe the segmentation output; they are not clinical conclusions.

## Select native SynthSeg

Set `NEURODESK_SYNTHSEG_BIN` to the absolute path of an installed SynthSeg
executable, then request `engine: "native"`. Supply `ct: true` or `ct: false`
explicitly; the native CLI does not use the browser's intensity detection.
The server invokes the executable without a shell and records its actual model,
version and backend from the JSON sidecar. Native reports retain that provenance;
the browser's per-label measurement summary is not added to native reports.
The server never silently changes engines. The validated browser GPU ceiling is unchanged.

## Generate a selector job

Save a run request as `request.json`, then run:

```sh
node scripts/automation-job.mjs brain-extraction request.json job.json
neurodesk-webapps --job job.json --output /data/new-results
```

Generated jobs wait on explicit run state and identity, not displayed status text.
Existing schema-1 selector jobs remain supported. The runner checks CSS selector
syntax in the browser before executing actions. The job timeout is an overall
deadline; individual step timeouts can shorten a wait.

## Add an application

Add `apps/<id>/automation.json` and use
`createRunState` from `@neurodesk/webapp-components/automation` in the app's normal
input and processing handlers. Begin a loading run before reading input, publish
`ready` after import, then begin a processing run. Complete it with named `File`
artifacts and scientific provenance. Guard asynchronous continuations with the
run handle's `current` property. Failure and cancellation must update that handle.

Use `#statusText` for the shared state attributes and keep the generated
`#neurodesk-run` JSON script. Key result rows with `data-stage` through
`createResultList`. Test the contract's inputs through processing and downloads
against the built application. Do not infer scientific coordinate spaces or
label conventions from filenames.

Run the desktop tests, the app's production browser tests and
`xvfb-run -a node scripts/desktop/automation-smoke.mjs` on Linux. The latter drives
the real desktop MCP endpoint and BET pipeline. GPU parity tests remain separate.

# Generate NeuroFlow tools

The generator turns each schema-2 `automation.json` operation into a NeuroFlow
0.1 tool document. It copies one dependency-free Node launcher into the bundle.
The launcher calls the desktop MCP interface, so no per-app DOM wrapper is
needed. Browser and native engines use the same generated document.

## Generate a registry bundle

From the Webapps repository, after `pnpm install --frozen-lockfile`:

```sh
node scripts/generate-neuroflow.mjs --out "$TMPDIR/neurodesk-neuroflow"
```

Or generate from one published contract, which already contains `appVersion`:

```sh
node scripts/generate-neuroflow.mjs \
  --contract /path/to/published/automation.json \
  --out "$TMPDIR/synthseg-neuroflow"
```

For an unpublished source contract, supply its package version with `--version`.
Generation fails if the version is missing. It validates the source with the
desktop's parser and every output against the pinned, unmodified upstream
schemas. It does not download schemas.

The destination contains `tools/<app>/<operation>.tool.json` and `scripts/`.
Move these together. The command produces identical bytes from identical
inputs and accepts an identical existing bundle. To update a changed bundle,
generate into a new directory. It refuses to overwrite unrelated or stale
files, and publishes a new bundle only after all documents are valid.

## Run through NeuroFlow

Install the Neurodesk desktop suite containing the same contracts. Set
`NEURODESK_WEBAPPS` to its executable path if it is not named
`neurodesk-webapps` on `PATH`. A macOS application bundle is a directory; use
the actual executable inside its `Contents/MacOS` directory.

```sh
export NEURODESK_WEBAPPS=/absolute/path/to/neurodesk-webapps
neuroflow-mcp --registry "$TMPDIR/neurodesk-neuroflow" \
  --data-root /absolute/path/to/data --check
```

Use the same command without `--check` as the MCP server command. Configure
`--interpreter node=/absolute/path/to/node` if the host's PATH lacks Node.
Generated MCP names contain only letters, digits, underscores and hyphens,
and are at most 64 characters.

A SynthSeg call uses the generated inputs:

```json
{
  "input_image": ["/absolute/path/to/T1.nii.gz"],
  "param_mode": "default",
  "param_ct": false,
  "engine": "native"
}
```

The native engine still needs the desktop's configured SynthSeg executable.
Availability is checked at execution time. Select `browser` for WebGPU execution
through the desktop app. Its existing resource limits, including the 2 GiB
SynthSeg cap, still apply. `NEURODESK_TIMEOUT_MS` sets the launcher deadline in
milliseconds, default 1800000 and maximum 86400000. Configure NeuroFlow's
`--step-timeout` to allow that time plus process cleanup.

For source-tree testing, `NEURODESK_WEBAPPS_ARGS` is a JSON array of arguments
placed before `--mcp`. Paths and arguments are passed directly to the child
process; the launcher never constructs a shell command.

## Mapping and guarantees

| Contract | Generated tool |
| --- | --- |
| App + operation | `neurodesk.webapps/<app>/<operation>` |
| App version | Tool version and installed-contract check |
| File input role | `input_<role>`, array of artifact references |
| URL / directory role | `input_<role>`, URL string / directory reference |
| Parameter | `param_<name>`, scalar or array, with defaults and numeric bounds |
| Artifact role | `output_<role>`, array, including roles that currently emit one file |
| Engine list | `engine` enum, defaulting to the first declared engine |
| Report | `report`, a JSON file with actual run provenance and measurements |
| Formats, space, labelSystem, cardinality | Unchanged source declaration in `neurodesk/data` |
| Nested constraints and multipleOf | Unchanged declaration in `neurodesk/parameter` |
| Limits and operation mode | Full source contract in `neurodesk/automation` |

File inputs remain arrays, and output roles always return arrays. This keeps
single-output and variable-output workflows consistent. Cardinality on DICOM
inputs counts logical images after series selection, not the number of slice
files. A multi-series input that needs a selection fails with the desktop's
diagnostic; this adapter does not guess a series. Select or convert that series
before running it through this interface.

The generator uses standard artifact types when their representation matches,
including `core:tabular` for `neuro:table`, `neuro:tract` for
`neuro:tractogram`, and `neuro:gradient-table` for `neuro:gradients`.
Other Neurodesk-specific `neuro:` types become `neurodesk:` extension types.
Their original declarations remain in the extension. A union of artifact
types uses `core:file` with the union preserved and verified by the adapter.
Nested parameter arrays use `core:json` elements at the unsupported nesting
boundary, with their full schema still enforced by desktop validation.

Before executing, the launcher checks the installed contract against a
canonical SHA-256 of the complete source contract, then calls `apps_validate`.
A same-version contract change also requires regeneration. It calls
`runs_start`, polls `runs_get`, and reads completed artifacts as MCP resources.
Artifacts above the desktop's 64 MiB resource limit are streamed from that
run's verified local output directory, with the same size and hash checks.
The launcher does not trust an arbitrary path supplied in the report.
It checks report identity, artifact roles, semantic types, cardinality, byte
counts and SHA-256 values. It writes NeuroFlow's `result.json` atomically only
after verification. Scientific errors and mismatched contracts fail the step.
SIGINT, SIGTERM and timeouts cancel the run and close the desktop process.

Viewer operations load and inspect their input and return a report, then close
the viewer. They do not leave a retained interactive session inside NeuroFlow.
Use the desktop MCP viewer controls directly when an agent needs that session.

NeuroFlow 0.1 does not interpret the vendor data constraints. Desktop preflight
enforces the checks its contracts support; annotations such as `native` or
`FreeSurfer` alone do not prove space or label-system compatibility. See the
[type-constraint RFC draft](../../../docs/rfcs/0010-neuroflow-data-constraints.md)
for the proposed portable semantics and runtime checks.

## Verification

```sh
node --test test/neuroflow-generator.test.mjs
```

The tests cover the full catalog, deterministic generation, upstream schemas,
input-name collisions, collection outputs, contract drift, hash mismatches,
scientific failure, browser/native selection and cancellation. The transport
tests use the actual desktop MCP/service implementation with a clearly labelled
test executor; they do not claim scientific inference accuracy.

The [schema snapshot record](vendor/README.md) pins the upstream spec and runtime
used for compatibility testing. The RFC is a draft in this repository; it has
not been submitted or adopted upstream.

For a real scientific integration check, build `neuroflow-mcp` in the upstream
runtime checkout and build this repository's brain-extraction app. Then run:

```sh
pnpm --filter brain-extraction build
NEUROFLOW_MCP_BIN=/absolute/path/to/neuroflow-mcp \
  xvfb-run -a node scripts/desktop/neuroflow-smoke.mjs
```

Use `node` without `xvfb-run -a` on a Mac with a graphical session. Linux
containers that require Electron's sandbox override can set
`NEURODESK_CONTAINER=1`. The check runs the actual upstream runtime, generated
launcher, desktop MCP server and BET worker. It compares the binary mask with
the pinned voxel count and SHA-256 golden, verifies geometry and artifact
hashes, and keeps evidence outside the checkout. It does not test WebGPU
inference or native Metal.

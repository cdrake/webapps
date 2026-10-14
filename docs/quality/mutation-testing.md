# Mutation testing

Run `pnpm quality:mutations` after `pnpm install --frozen-lockfile --ignore-scripts`.
Stryker mutates the modules listed in `scripts/lib/mutation-modules.mjs`. Each
entry names the source (or a line range of it), the files its suite needs in the
sandbox, and the `node --test` command that specifies it. The adapter runs
Stryker once per module, selecting it with `MUTATION_MODULE` in
`stryker.config.mjs`, so each mutant runs only its own suite. None of the suites
needs model files, native binaries, WASM execution, a GPU, a browser or the
network.

| Module | What a wrong result breaks | Suite |
| --- | --- | --- |
| `packages/nii2tvx/src/disconnectome.js` | Disconnectome table names and grid refusals shared by the app and command line | `packages/nii2tvx/test/disconnectome.test.js` |
| `packages/lcmodel/src/basis-select.js` | Which LCModel basis set the app preselects, which ones it marks unusable, and the advice it shows; a mismatched basis biases concentrations | `packages/lcmodel/test/basis-select.test.js` |
| `packages/nii2tvx/src/index.js:24-35` (`formatG`) | The browser TSV must equal the native `printf("%g")` output byte for byte | the `printf("%g")` tests in `packages/nii2tvx/test/parity.test.js` |

`formatG` is mutated by line range because the rest of `index.js` drives the
WebAssembly module. Its command selects the two `printf` tests by name; the rest
of `parity.test.js` needs a native build and is not part of this run.
`test/mutation-quality.test.mjs` fails when a range no longer covers exactly its
function or the name pattern selects other tests.

Stryker is pinned to `@stryker-mutator/core@10.0.0`. The current
[runner configuration](https://stryker-mutator.io/docs/stryker-js/configuration/#testrunner-string)
supports arbitrary test commands. The official plugin list and published package
schema do not provide a native node:test runner, so the command runner runs the
suites with `node --test` and `coverageAnalysis: 'off'`. It cannot map tests to
files, which is why each module is a separate run: in one shared run every
mutant would execute every suite, and the slower runs could turn into false
timeouts. The runner reports a suite as one test and cannot distinguish
uncovered mutations from mutations that survive assertions.

Only the module's listed files are copied into Stryker's sandbox. Concurrency is two.
The sandbox stays inside the checkout at `.stryker-tmp` and is cleaned even on
failure. Node test fixtures use the host's `TMPDIR` storage volume locally and
the runner temporary directory in CI. The reporting adapter clears the inherited
`NODE_TEST_CONTEXT` marker so nested node:test suites execute independently.

## CI and failures

The independent `mutation-quality` workflow runs every module weekly and on
manual dispatch. Pull requests run `pnpm quality:mutations:smoke`, which mutates
only the `tableName` function (`smoke` in the configuration). Its requirement to
kill at least one mutant proves that instrumentation reaches the Node tests. It
is not a mutation-score threshold.

Both modes write a GitHub summary with one row per module and upload
`quality-artifacts/mutations`: `<module>/mutation.json` and `<module>/index.html`
for each run, `summary.md`, and `stryker.log` with every run's output. Surviving mutations and scores are report-only. The summary
lists survivors for review. Invalid configuration, failing baseline tests,
scanner crashes, runner runtime errors, missing reports, a report whose modules
differ from the configuration, and a module with no assessed mutants fail the
job. The first failing module stops the run. The adapter removes previous reports before running so a failed scan cannot
reuse an old score.

The repository tests exercise real Stryker configuration and baseline failures,
crash handling, report validation and the distinction between a surviving mutation
and a broken smoke canary. No exception is swallowed to keep the workflow green.

## Runtime budget

Measured locally on 2026-10-14 (two workers):

| Run | Mutants | Wall time |
| --- | --- | --- |
| Baseline (Stryker's initial suite run, per module) | - | 0.3-0.7 s |
| PR smoke | 2 | 5 s |
| Full run, three Stryker runs | 332 | 96 s |

The full run before `basis-select.js` and `formatG` were added took about 4 s.
The workflow's 10-minute timeout leaves room for slower hosted runners. Keep the
full run under five minutes locally; add a module only with its own completed
run and a measured cost.

## Results and reviewed survivors

The pilot on 2026-10-10 killed all 10 mutants in `disconnectome.js`.

The full run on 2026-10-14 killed 319 of 332 mutants, with 13 survivors and no
timeouts, compile errors or runtime errors:

| Module | Killed | Survived |
| --- | --- | --- |
| `disconnectome.js` | 10 | 0 |
| `basis-select.js` | 264 | 10 |
| `formatG` | 45 | 3 |

The first run of `basis-select.js` left 134 of 274 mutants alive: the suite
never exercised related sequence families, unrecorded parameters, the field and
echo-time tiers, the notes users read or most header-parsing rules. The first run
of `formatG` left 14 of 48: infinities, negative values and six-digit exponents
were untested. Behavioral tests now cover these. The survivors that remain do not
change a result the app, the pipeline or the command line exposes:

Equivalent mutants:

- `basis-select.js:27` `if (!name)` to `false`: `String(null)`, `String(undefined)`
  and `""` match no sequence family either.
- `basis-select.js:51` and `:55`, `>=` to `>` at the 20 % and 5 % field limits:
  for a ratio near 1 the mismatch `|q - 1|` is a multiple of 2^-53, and the
  doubles nearest 0.2 and 0.05 are not, so the mismatch never equals either limit.
- `basis-select.js:138` reading the whole text instead of its first 64 KiB: a
  `.BASIS` file's header namelists precede its spectra, so the first match is the
  same. The limit only bounds the regular-expression scan.
- `formatG` line 26, `x === 0` to `false`: zero then takes the fixed branch and
  still prints `0`.
- `formatG` line 27, `x > 0` to `x >= 0`: only reached for infinite `x`.
- `formatG` line 32, `/^[-+]/` to `/[-+]/`: the exponent string has a sign only
  at its start.

Score changes without a specified ranking. These are not equivalent, but no
documented rule decides the order they change, so a test would pin an
implementation weight rather than a requirement:

- `basis-select.js:53` and `:75`, `score -= 100` to `+=`, and `:79` `dataSeq === null`
  to `true` or `!==` for sequence-known data: they reorder only unusable sets,
  which always follow every usable set and are labelled unusable in the menu.
- `basis-select.js:79` `dataSeq === null` to `false` or `!==` for data of unknown
  sequence, and `:88` `score -= 10` to `+=`: they move a difference basis by 40
  or 20 points against unedited sets for the same data. The difference basis
  stays usable, warned and below any unedited set that matches field and echo
  time, which the suite checks.

This score applies only to these modules and these mutation operators. It does
not measure scientific accuracy, native/browser parity or the rest of either
package. Keep the independent scientific references and golden-output tests
unchanged. Review future survivors for equivalent behavior before changing
tests, and add a test only when the surviving change represents a relevant
incorrect result. Expand scope one fast, deterministic module at a time, with
its own completed run.

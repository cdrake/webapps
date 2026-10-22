# hmc reference data

The head-motion correction tests compare the port with NiFreeze 3bcfb00 and QSIPrep 26.1.1 runs on OpenNeuro ds005577 sub-107 (CC0).
The runs are `hmc/reference/` of the Hugging Face dataset `neurodeskorg/webapps`: 3513 files, 439 MB.
That folder's `README.md` gives each file's purpose, the software and the licences.

`reference.manifest.json` pins the folder at one dataset commit, with each file's size and SHA-256, and names the subsets that tests read:

| Subset | Files | Size | For |
| --- | --- | --- | --- |
| `decomposition` | 1408 | 4.5 MB | motion tables, ITK transforms and rotated b-vectors of every run |
| `clip` | 3 | 1.7 MB | NiFreeze's in-place clip (Q55) |
| `gp` | 102 | 110 MB | the GP model against NiFreeze's 90 predictions (`tests/gp_reference.rs`) |
| `nifreeze-replay` | 1313 | 190 MB | registration replay (`tests/registration_reference.rs`, `tests/q53_replay.rs`): samples, predictions, masks, command lines, Q53 b0 pairs |
| `shore` | 294 | 236 MB | SHORELine: split volumes, predictions, templates, QSIPrep configuration |

## Run the tests on the data

```sh
export $(python3 exes/dwi/hmc/validation/fetch_reference.py /var/tmp/hmc-reference decomposition clip gp)
cd exes/dwi && HMC_REQUIRE_REFERENCE=1 cargo test --release --workspace --locked
```

`fetch_reference.py` downloads only the named subsets (or `all`), checks each file's size and SHA-256, and does not download a verified file again.
It prints `HMC_REFERENCE` (the folder) and `HMC_REFERENCE_SUBSETS` (what it holds).
Without `HMC_REFERENCE` the data tests pass and do nothing; with `HMC_REQUIRE_REFERENCE` set, missing data is a failure.
The `hmc-reference` job in `.github/workflows/dwi-native.yml` does this for the subsets that tests read.

`tests/reference_subsets.rs` checks that every file of each fetched subset is present at its pinned size, and reads two of them: the ITK transforms of the six NiFreeze runs against their `motion_affines.tsv`, and the trivial model's clip of `bzero` against its prediction.
Both are exact.

## Registration replay (Q53, #446)

`packages/hmc-registration/validation/nifreeze-replay.mjs` runs NiFreeze's kept registrations through the WebAssembly kernel: the 90 GP volumes, and the 11 b0 pairs of `q53-b0/`, whose moving images it cuts from the input as `scripts/q53_b0.py` did with nibabel (byte for byte).
`tests/q53_replay.rs` compares each result with native double at the same seed and with the double seed-to-seed spread, per volume and axis, and holds the whole table to `q53-replay.json`:

```sh
node packages/hmc-registration/validation/nifreeze-replay.mjs "$HMC_REFERENCE" /var/tmp/q53-replay
cd exes/dwi && HMC_WASM_REPLAY=/var/tmp/q53-replay cargo test --release -p dwi-hmc --test q53_replay -- --nocapture
```

After a deliberate change of the kernel or the argv, rewrite the table with `HMC_Q53_WRITE=1` and give the new failing cells in the PR.
`tests/registration_reference.rs` checks that `registration::nifreeze_argv` writes all 540 kept commands.

## Re-pin

After an upload changes `hmc/reference/`, regenerate the manifest from the new commit:

```sh
python3 exes/dwi/hmc/validation/make_manifest.py <40-hex commit>
```

It reads the folder's `SHA256SUMS` and the Hugging Face tree at that commit, and fails when they disagree or when a subset pattern matches no file.
Subset patterns are in `SUBSETS` in that script; they are fnmatch globs in which `*` also crosses `/`.

# Unused-code triage, 2026-10-22

`pnpm quality:unused` with Knip 6.41.0 on `main` at `07d0e161` reported 31
candidates and an empty `diagnostics.log`. That is the 29 candidates of the
[2026-10-17 record](unused-code-triage-2026-10-17.md) less SYNcro's
`@brainchop/mindgrab`, which is now reached, plus three new ones. This change
resolves the three new candidates and leaves 28.

## Resolved

| File | Kind | Resolution |
| --- | --- | --- |
| `packages/components/src/handoff/receive.js` | File | `site/app-shell.js` imports it by URL from the staged shell components. Every JavaScript file in `SHELL_COMPONENTS` (`scripts/lib/standalone.mjs`) is now a Knip entry. |
| `exes/fastprep/core/src/assets/sdc.js` | File | fastprep's Rust report inlines it with `include_str!`. It is now a root entry. |
| `packages/syncro/src/assets.js` | `templateAsset` export | Removed. The app has fetched the MNI152 template from the shared template catalogue since `3329c394`, and a repository-wide search found no other reference. The template's entry in `models/syncro.manifest.json` stays; Knip does not scan manifests. |

`test/unused-code.test.mjs` now also requires the two new entries.

## Remaining

The 16 runtime and staging findings and the five kept by owner decision or vendoring
contract are unchanged from the 2026-10-17 record, less SYNcro's `@brainchop/mindgrab`.
The remaining eight upstream-owned findings were checked against the upstream default
branches on 2026-10-22:

| Upstream | Findings | Count | Status |
| --- | --- | ---: | --- |
| QSMbly `main` at `0b6e3d3` | `js/modules/file-io/index.js`, `js/modules/mask/index.js` | 2 | Both barrels are still on upstream `main`. Tracked in [astewartau/qsmbly#157](https://github.com/astewartau/qsmbly/issues/157), which is open. |
| dicompare-web `main` at `d3d0879`, the synced pin | `src/types/fieldValues.ts`; the `Template`, `AcquisitionComplianceResult` and `ProcessingProgress` types in `src/types/index.ts`; `SchemaField` in `src/types/schema.ts`; `FileSizeInfo` in `src/utils/fileUploadUtils.ts` | 6 | Upstream's own fix for [astewartau/dicompare-web#25](https://github.com/astewartau/dicompare-web/issues/25) removed the files that used these. A search of upstream `src` and `electron` at `d3d0879` finds no importer of `fieldValues.ts` and no other use of the five types, so they are dead upstream as well. No upstream issue tracks them yet. |

Neither copy is edited here: both apps take upstream fixes through the weekly sync.

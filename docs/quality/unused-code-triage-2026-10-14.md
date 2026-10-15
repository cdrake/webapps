# Unused-code triage, 2026-10-14

This file records how each candidate in the 2026-10-14 report was classified, for issue #256.

## Report

The report was run from `origin/main` at `4b28789c` with
`pnpm install --frozen-lockfile --ignore-scripts` and then
`pnpm quality:unused` (Knip 6.41.0).
The scan exited successfully. `diagnostics.log` was empty, so there were no scan warnings.

| Kind | Before | After the source removals | After the dependency removals |
| --- | ---: | ---: | ---: |
| files | 17 | 16 | 16 |
| exports | 69 | 40 | 40 |
| types | 14 | 14 | 14 |
| duplicates | 1 | 1 | 1 |
| dependencies | 18 | 18 | 15 |
| devDependencies | 28 | 28 | 7 |
| total | 147 | 117 | 93 |

Each candidate has one of these dispositions:

- **Removed**: verified dead and deleted in this change.
- **Runtime**: a legitimate external, runtime or test entry that Knip cannot see.
- **Upstream**: owned by an upstream-synchronized app (`apps/<id>/upstream.json`), so it is classified here but not edited.
- **Redundant, removed**: verified as an unneeded declaration and removed in a separate lockfile change (see [Dependency removals](#dependency-removals)).
- **Kept**: unreachable, but deliberately kept, with the reason given.

## Evidence used for removals

For every removed symbol or file, `git grep -w` across the whole repository found no reference outside the defining file. The search excluded only `CHANGELOG.md` and `pnpm-lock.yaml`.
It covered:

- HTML, Markdown and JSON, including `runtime-assets/manifest.json` and `registry/`
- staging scripts (`scripts/vendor-*.mjs`, `stage-*.mjs`, `setup.sh`)
- validation tools and `scripts/lib/app-versions.mjs`

It also covered the app test scripts that load sources through constructed `import()` paths, `loadClassicScript` or `readFileSync` source strings.
No removed file is named in `config/dependency-quality.mjs` or in a package `exports` or `bin` entry.
After the removals, the report produced no new candidates: no helper became unused as a result.

| Candidate | Disposition | Evidence |
| --- | --- | --- |
| `apps/vesselboost/web/js/modules/pipeline/n4-shrink-policy.js` (file) | Removed | This classic-script shim set `globalThis.VesselBoostN4Policy`, which nothing reads. `index.html` does not load it. The worker gets the policy from the staged `packages/vesselboost/src/pipeline.js`. `test:n4-shrink-policy` tests the shared package directly and still passes. |
| `apps/ants/src/config.js` `APP` | Removed | No importer. Only the template's `main.js` uses its own `APP`. |
| `apps/edgereg/src/config.js` `APP` | Removed | Same as ants. |
| `apps/greedy/src/config.js` `APP` | Removed | Same as ants. |
| `apps/calmar/web/js/app/atlas-options.js` `getDefaultAtlasOption` | Removed | No caller. `lnm-app.js` uses `DEFAULT_ATLAS_OPTION_ID` directly. |
| `apps/calmar/web/js/app/lnm-labels.js` `YEO7_NETWORK_LABELS` | Removed | No reference anywhere. |
| `apps/dicom2vid/web/js/ingest.js` `readAsArrayBuffer` | Removed | No caller. `app.js` imports only `collectFromDrop`, `collectFromPicker` and `readPrefix`. |
| `apps/dicom2vid/web/js/readers/index.js` re-exports `parseDicom`, `DicomError`, `NiftiError`, `MgzError` | Removed | Only the barrel's re-exports are gone. The tests import these from `readers/dicom.js`, `nifti.js` and `mgz.js`, which keep them. |
| `apps/musclemap/web/js/app/labels.js` `getLabelSpaceForModel`, `INDEX_TO_VALUE`, `VALUE_TO_INDEX` | Removed | No reference. The only other mention is a historical `rg` command in a migration plan. |
| `apps/spinalcordtoolbox/web/js/app/labels.js` `LABELS`, `getLabelColor` | Removed | No reference. Labels come from `getTaskLabels`. `test_labels.mjs` imports only `generateLabelColormap` and `getLabelName`. |
| `apps/spinalcordtoolbox/web/js/app/sct-tasks.js` `getTaskForegroundLabel` | Removed | No reference. |
| `apps/vesselboost/web/js/app/labels.js` `getLabelColor` | Removed | No reference. |
| `apps/synthsr/src/volume.js` re-exports `rasAxes`, `gaussian`, `resample1mm` | Removed | This app-local shim is imported only by tests and e2e specs, which use the five remaining names. `@neurodesk/synthsr` keeps its API unchanged. |
| `packages/synthsr/src/gpu-conv3d.js` re-export `conv3dShader` | Removed | This test-only shim is not in `exports`. The Conv3D spec reads `conv3dShader` from `runtime-support/src/gpu-unet/conv3d.js`. |
| `packages/components/src/file-io/DisplayPreview.js` `parseNiftiHeader`, `extractAffine`, `isGzipped`, `readNiftiImageData`, `createUint8Nifti`, `createFloat32Nifti`, `createNiftiHeaderFromVolume`, `extractNiftiHeader` | Removed | These were a second copy of the NIfTI parser and writer. The package `exports` publish only `createUint8PreviewNiftiFile` from this module (through `./file-io`), and that function uses none of them. Every caller of these names imports the `NiftiUtils.js` versions. The private sform/qform helpers were removed with them. |

## Kept as runtime entries or by decision

| Candidate | Disposition | Evidence |
| --- | --- | --- |
| `apps/spinalcordtoolbox/web/js/modules/sct-processing.js` `default` | Runtime | This is a UMD wrapper. Knip reads `module.exports` as a default export. The app loads it as a side-effect import that sets `self.SCTProcessing`, and `test_sct_processing.cjs` loads it with `loadClassicScript`. |
| `apps/calmar/web/js/app/lnm-tasks.js` `getRequiredAssetIds`, `isPipelineRunnable` | Runtime (test API) | Exported for `scripts/test_lnm_tasks.mjs`, which imports through a constructed `pathToFileURL` URL that Knip cannot follow. |
| `apps/spinalcordtoolbox/web/js/app/sct-tasks.js` `buildManifest` | Runtime (test API) | Read by `scripts/test_manifest_consistency.mjs` through a constructed `import()`. |
| `packages/runtime-support/src/niimath/types.d.ts` `dataTypes` | Kept | This is part of the frozen, vendored niimath build (see that directory's README). The declarations stay byte-identical to the build until Deface moves to npm niimath. |
| `packages/topofit/src/affine.js` `prepareTemplates`, `mni305ToMni152` | Kept | These are unreachable scientific transform helpers, including the MNI305 to MNI152 matrix. Under #256 item 6, removing them needs the TopoFit owner's decision and parity evidence. Deleting them would not change the byte-pinned outputs. |
| `packages/nesvor/src/output/index.js` re-exports `blurSupport`, `gaussianRandom` | Kept | These belong to the scientific output barrel. Both functions stay in use as defaults inside `support.js` and `sample.js`. Leave the re-exports until a NeSVoR output change has parity evidence. |

## Dependencies

| Candidate | Disposition | Evidence |
| --- | --- | --- |
| `eslint` devDependency in ants, brain2print, brain-extraction, carotid-flow, disconnectome, dwi2trx, edgereg, elastix, fireants, greedy, lcmodel, nesvor, synthseg, topofit, white-matter-lesions, vessel-surfer and vessel-surfer-leaderboard (17) | Redundant, removed | Each `eslint.config.js` re-exports the root configuration. `lint` runs the root `scripts/lint.mjs`, which resolves the root's `eslint@9.39.5`. CI installs the whole workspace, never a filtered subset. Sixteen other apps declare no `eslint` at all. |
| root `ajv`, `ajv-formats` | Redundant, removed | Only `packages/desktop/neuroflow/generator.mjs` imports them. Node resolves them from `packages/desktop`, which declares both. |
| `packages/node-drivers` `vite` | Redundant, removed | Nothing in the package references Vite. `validation/browser-reference.mjs` serves with `node:http`. Neither pinned runtime declares Vite as a peer. |
| `apps/vesselboost` `onnxruntime-node`, `jsdom` | Redundant, removed | Nothing in the app references them. `packages/vesselboost` declares its own `onnxruntime-node` for `src/node.js`. |
| `apps/spinalcordtoolbox` `nifti-reader-js` | Redundant, removed | `web/nifti-js/index.js` is staged from `packages/runtime-support/src/nifti-js`, not from npm. Only planning documents name the package. |
| `apps/dwi2trx` `fflate` | Redundant, removed | Nothing in the app imports it. `@dipy/gpu-streamlines` declares its own `fflate` dependency. Keep the NOTICE entry, because the bundle still contains fflate. |
| `apps/browserqc`, `apps/deface`, `apps/dwi2trx` `@niivue/dcm2niix` | Runtime (unresolved) | The apps use `@neurodesk/runtime-support/dcm2niix-client`, which declares the package. Each Vite config names it in `optimizeDeps.exclude`. Removal needs a production build and e2e DICOM import per app, because Vite resolves the worker's import from the app. BrowserQC is also upstream-synchronized. |
| `apps/synthsr` `onnxruntime-node`, `packages/synthstrip` `onnxruntime-node` (devDependencies) | Runtime | Loaded by `createRequire(import.meta.url)('onnxruntime-node')` in `test/wasm.test.js` and `test/browser.test.js`. Knip does not follow that call. |
| `apps/dicom2vid`, `apps/easy-mp2rage` `@neurodesk/webapp-components` | Runtime | `scripts/vendor-components.mjs` and `scripts/build-static.mjs` copy the package into `web/vendor/webapp-components`. The workspace dependency also places the app in the CI plan of the shared package. |
| `apps/easy-mp2rage` `@neurodesk/easy-mp2rage` | Runtime | `tools/stage_core.sh` copies the package's WASM core into `web/vendor`. |
| `apps/musclemap` `@neurodesk/musclemap`, `apps/vesselboost` `@neurodesk/vesselboost` | Runtime | `pnpm vendor` stages the package into `web/vendor` (`stage-pipeline.mjs`, `stage-browser.mjs`). |
| `apps/syncro` `@neurodesk/syncro`, `@brainchop/mindgrab` | Runtime | The app imports `../../../packages/syncro/src/*` by relative path. `scripts/copy-runtime-assets.mjs` resolves `@brainchop/mindgrab/package.json`. |
| `packages/nesvor` `@neurodesk/synthsr`, `@neurodesk/webapp-components` | Runtime | Relative imports reach both: `../../synthsr/src/volume.js` and `../../../components/src/worker/fetchModel.js`. The declarations record these edges for `scripts/lib/app-plan.mjs`. |
| `packages/syncro` `@neurodesk/registration`, `@neurodesk/synthsr`, `@neurodesk/synthstrip` (devDependencies) | Runtime | Reached by relative path: `scripts/build.mjs` copies `../../registration/wasm`, `src/assets.js` reads `../../synthsr/model.manifest.json`, and `src/node.js` imports `../../synthstrip/src/index.js`. |
| `apps/seedseg` `@neurodesk/seedseg` | Upstream / Runtime | `pnpm vendor` stages the shared pipeline. The integration rules in `upstream.json` require this package. |
| `apps/dicompare` `@testing-library/user-event`, `@types/react-router-dom`, `@electron-toolkit/preload`, `@types/jszip` | Upstream | These are dicompare's own package declarations. |

## Dependency removals

The redundant declarations were removed in one lockfile change, kept separate from the source deletions because a root `package.json` dependency change selects the whole catalog in CI.
Each entry was re-checked on `origin/main` at `e2fb6b76` before removal.
The search covered static, dynamic and `createRequire` imports, package scripts, staging and copy scripts, HTML, worker URLs, validation tools, workflows and the `exes/node-cli` packager.

- The 17 `eslint` declarations: every `lint` script is `node ../../scripts/lint.mjs --workspace` (three levels up for the easter eggs), and every `eslint.config.js` re-exports the root configuration, so ESLint resolves from the root. `templates/app-template` lost the same declaration, so `pnpm new-app` no longer copies it into new apps.
- Root `ajv` and `ajv-formats`: the root tests and `scripts/generate-neuroflow.mjs` import `packages/desktop/neuroflow/generator.mjs`, which resolves both from `packages/desktop`.
- None of the removed packages is a workspace package, so `scripts/lib/workspace-graph.mjs` has the same edges and no app leaves another package's CI plan.
- The lockfile change removes importer entries only. Every package keeps its locked version, because each is still resolved for another importer: `fflate` 0.8.3 for `@dipy/gpu-streamlines`, `onnxruntime-node` for `packages/vesselboost` and SCT, and `ajv` for `packages/desktop`.

## Upstream-owned candidates

QSMbly, SeedSeg, dicompare and BrowserQC are synchronized from upstream repositories (`upstream.json`). Their findings are classified here and left unedited. Fix them upstream, or in a scoped upstream-sync PR that follows the integration rules.

| File | Kind | Candidates |
| --- | --- | --- |
| `apps/qsmbly/js/controllers/QsmEchoViewer.js` | exports | `QsmEchoViewer` |
| `apps/qsmbly/js/modules/file-io/index.js` | files | upstream barrel module |
| `apps/qsmbly/js/modules/mask/index.js` | files | upstream barrel module |
| `apps/dicompare/src/components/common/ConstraintInputWidgets.tsx` | files | (file) |
| `apps/dicompare/src/components/common/DataTypeSelector.tsx` | files | (file) |
| `apps/dicompare/src/components/common/TypeSpecificInputs.tsx` | files | (file) |
| `apps/dicompare/src/components/common/ValidationConstraintSelector.tsx` | files | (file) |
| `apps/dicompare/src/components/schema/acquisition-table/index.ts` | files | (file) |
| `apps/dicompare/src/components/schema/acquisition-table/UncheckedFieldsDisplay.tsx` | files | (file) |
| `apps/dicompare/src/components/schema/index.ts` | files | (file) |
| `apps/dicompare/src/components/viewer/DicomViewerModal.tsx` | files | (file) |
| `apps/dicompare/src/components/workspace/AcquisitionMatchingModal.tsx` | files | (file) |
| `apps/dicompare/src/hooks/useUncheckedFields.ts` | files | (file) |
| `apps/dicompare/src/hooks/useValidationRuleCompliance.ts` | files | (file) |
| `apps/dicompare/src/services/PyodideManager.ts` | files | (file) |
| `apps/dicompare/src/utils/batchProcessor.ts` | files | (file) |
| `apps/dicompare/src/utils/fieldProcessing.ts` | files | (file) |
| `apps/dicompare/src/components/common/constraintModel.ts` | exports | `failEdges` |
| `apps/dicompare/src/components/common/StatusIcon.tsx` | exports, duplicates | `StatusIcon`; `StatusIcon + default` |
| `apps/dicompare/src/hooks/useFileSystemAccess.ts` | exports | `useBatchConfig` |
| `apps/dicompare/src/services/dicomFieldService.ts` | exports | `getFieldByTag`, `getFieldByName`, `getFieldSuggestions`, `getFieldsByCategory`, `getEnhancedFieldSuggestions` |
| `apps/dicompare/src/types/fieldValues.ts` | exports | `isListStringField`, `isListNumberField`, `isJsonField`, `validateAgainstRule` |
| `apps/dicompare/src/utils/datatypeInference.ts` | exports | `processSchemaSeriesFieldValue` |
| `apps/dicompare/src/utils/fieldFormatters.ts` | exports | `formatTypedFieldValue`, `formatConstraint`, `formatConstraintValue` |
| `apps/dicompare/src/utils/fileHandleManager.ts` | exports | `NO_BATCH_THRESHOLD_BYTES` |
| `apps/dicompare/src/utils/fileSystemAccessUtils.ts` | exports | `countDirectoryFiles`, `isProtocolFile` |
| `apps/dicompare/src/utils/fileUploadUtils.ts` | exports | `checkFileSizeLimit`, `hasValidDicomFiles` |
| `apps/dicompare/src/utils/schemaFieldConverters.ts` | exports | `acquisitionFieldToSchemaField` |
| `apps/dicompare/src/utils/schemaToAcquisition.ts` | exports | `convertRawAcquisitionToContext` |
| `apps/dicompare/src/utils/tagUtils.ts` | exports | `splitTags` |
| `apps/dicompare/src/utils/technicalLog.ts` | exports | `formatLogLines`, `useErrorSignal`: this file is a monorepo adaptation (`93381e89`), not upstream code, so a dicompare-scoped follow-up could remove these |
| `apps/dicompare/src/utils/valueRounding.ts` | exports | `roundFieldValues` |
| `apps/dicompare/src/utils/vrMapping.ts` | exports | `getVRDescription`, `isNumericVR`, `canHaveMultipleValues` |
| `apps/dicompare/src/components/common/ConstraintBandEditor.tsx` | types | `GradedConstraint` |
| `apps/dicompare/src/components/validation/ValidationFunctionLibraryModal.tsx` | types | `FieldDefinition` |
| `apps/dicompare/src/contexts/ItemManagementContext.tsx` | types | `WorkspaceItem` |
| `apps/dicompare/src/contexts/ProcessingContext.tsx` | types | `ProcessingTarget`, `ProcessingProgress` |
| `apps/dicompare/src/contexts/SchemaMetadataContext.tsx` | types | `SchemaMetadata` |
| `apps/dicompare/src/contexts/WorkspaceContext.tsx` | types | `PendingAttachmentSelection`, `PendingMatchingOperation` |
| `apps/dicompare/src/types/index.ts` | types | `ComplianceStatus`, `DicomFile`, `AppState` |
| `apps/dicompare/src/types/schema.ts` | types | `ParsedSchema`, `ComplianceReport` |
| `apps/dicompare/src/utils/testDataGeneration.ts` | types | `TestDataGenerationResult` |

The `upstream.json` integration rules require some erased type imports (`ProcessingProgress`, `WorkspaceItem`) to avoid runtime import cycles. Report unused type exports upstream rather than deleting them here.

## Remaining work

- Before removing `@niivue/dcm2niix` from BrowserQC, Deface or dwi2trx, verify a production build and a DICOM import for each app.
- Send the dicompare and QSMbly findings upstream, or remove them in a scoped upstream-sync PR. Then remove the dicompare `technicalLog.ts` exports.
- TopoFit's affine helpers and the NeSVoR output re-exports need an owner decision with parity evidence.
- The calmar and SCT test APIs would stop appearing in the report if those tests used literal imports. Knip already follows literal imports.

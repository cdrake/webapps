# pipeline-builder

## 0.2.20261030

### Patch Changes

- 1e81185: Store array parameters such as QSMbly echo times, Easy MP2RAGE acquisition values and SeedSeg folds and models as typed JSON arrays. Their fields accept a JSON array or comma-separated values, check each value against the declared item type, range and choices, and show an error in place without changing the saved value. Number fields also reject text, fractional integers and values outside their range. Validation reports an imported constant that does not match its parameter type, which the NeuroFlow core does not check.
- Keep the saved parameter and show an inline error when a numeric field contains an incomplete number such as `1e`.
- 5b7e5f1: Refuse an imported workflow whose steps, bindings, inputs or outputs are not objects, instead of opening it and breaking every later edit until New. Report a reference to an undeclared workflow input as an error, which the NeuroFlow core does not check. A builder check that fails no longer hides the core's own issues.

## 0.2.20261029

### Patch Changes

- 57d9266: Validate with the NeuroFlow v0.3.0 core, which checks array item counts and warns when an optional tool output feeds a required input or a workflow output. Preserve the document's specification version during import and export so 0.1.2 item bounds remain valid. Point the run instructions at the v0.3.0 release and document cancellation limits.

## 0.2.20261027

### Patch Changes

- 46d4ee1: Adopt NeuroFlow v0.2.1. Its `neuroflow-mcp` inspects FSL gradient tables, so generated tool inputs now declare `bval` and `bvec` formats again and the runtime rejects a swapped pair before launch. `bval-bvec`, which names a pair of files, has no inspector and stays only in `neurodesk/data`. The `neuroflow` CI job builds the v0.2.1 commit, and the docs point to the release's prebuilt binaries and their `SHA256SUMS`. Exported workflows need `neuroflow-mcp` 0.2.1 or later.
- Updated dependencies
  - @neurodesk/webapp-components@0.22.2
- Updated dependencies
  - @neurodesk/webapp-components@0.22.1

## 0.2.20261024

### Minor Changes

- Preserve array workflow inputs, allow steps to move up and down without losing their bindings, and show input-count and optional-output warnings in Export.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.21.1
- Updated dependencies [328cb77]
  - @neurodesk/webapp-components@0.20.1
- Report a valid workflow in the console after its errors are corrected, while retaining warnings that require a runtime check.
- Reject imported workflow bindings whose known gradient format is incompatible with the input. Validate the full document before enabling export, so a bvec file cannot feed a bval input or vice versa.
- Updated dependencies [14a8b29]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.20.0
- Updated dependencies
  - @neurodesk/webapp-components@0.19.3
- State that the DWI preprocessing template requires at least two nonzero diffusion shells for its required NODDI ICVF output, and pin the revised hosted example.
- Add a DWI preprocessing template that passes acquisition metadata and gradients through denoising, Gibbs removal and motion correction, extracts a mask from the corrected mean b0, and supplies the corrected series to NODDI and tractography.
- Document how to execute exported workflows with the pinned NeuroFlow v0.2.0 runtime and the Neurodesk desktop suite. Add macOS CI checks that build that upstream runtime and execute the shipped T1 and DWI workflows through their real scientific operations, verifying output hashes and image contents.
- Use the same application title in the catalog, automation contract and About dialog so catalog interaction checks match the displayed app name.
- Preserve workflow inputs referenced by step conditions when clearing or replacing bindings and removing steps.
- Bind optional data inputs to matching earlier output roles and prefer the nearest matching image or gradient source across the workflow. Keep corrected DWI images ahead of derived maps and preserve brain-extracted inputs for SynthSeg. Label sources that need runtime checks and list them after clean choices, excluding known b-value and b-vector format mismatches.
- Updated dependencies
  - @neurodesk/webapp-components@0.19.2

## 0.1.20261024

### Minor Changes

- 6b704d9: Add Pipeline builder, a new app in the Pipelines category. It chains Neurodesk app operations into a NeuroFlow workflow, offers only the bindings the vendored NeuroFlow WebAssembly validator accepts, and exports `.workflow.json` files that `neuroflow-mcp` runs. The page publishes the generated tool catalog under `neuroflow/` as a NeuroFlow registry, and ships a T1 segmentation template (N4 → brain extraction → SynthSeg).

### Patch Changes

- Updated dependencies [bd5f3a8, 0066f60]
  - @neurodesk/webapp-components@0.22.0
- Updated dependencies [941884c]
- Updated dependencies [a028e96]
- Updated dependencies [650ce5f]
- Updated dependencies [343c256]
- Updated dependencies [941884c]
  - @neurodesk/webapp-components@0.21.0
- Updated dependencies [3a7e5bb]
- Updated dependencies [72cbb8d]
  - @neurodesk/webapp-components@0.20.0
- 39604c4: Changing a step's binding now drops a workflow input once no step reads it, so an exported workflow never declares an input that `neuroflow-mcp` would require and nothing uses. When the tool catalog cannot load, the automation `validate` operation fails with the load error and the drop zone accepts no workflow. Exported workflows need NeuroFlow 0.2.0 or later.

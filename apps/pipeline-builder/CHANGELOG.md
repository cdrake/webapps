# pipeline-builder

## 0.1.20261023

### Minor Changes

- 6b704d9: Add Pipeline builder, a new app in the Pipelines category. It chains Neurodesk app operations into a NeuroFlow workflow, offers only the bindings the vendored NeuroFlow WebAssembly validator accepts, and exports `.workflow.json` files that `neuroflow-mcp` runs. The page publishes the generated tool catalog under `neuroflow/` as a NeuroFlow registry, and ships a T1 segmentation template (N4 → brain extraction → SynthSeg).

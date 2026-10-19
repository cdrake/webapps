---
"qsmbly": patch
---

Merge upstream astewartau/qsmbly d2afebc..cf88ee3:

- Plan: run QSMxT's pipeline engine in the browser for QSMxT parity
- Delete the WASM exports nothing calls, and their defaults plumbing
- Pin the QSM stack once, on QSMxT
- Show the QSMxT and QSM.rs versions the WASM bundle was built against
- Check that every volume in a run is on one voxel grid (port of #118 to main)
- Pin QSMxT main, and let the build-versions test accept a commit pin
- rustfmt
- Plan: record the engine-crate decisions and phase 1 status
- Pin qsmxt-engine (renamed from qsmxt-config) on QSMxT main
- Plan: UI-facing steps wait for the UI redesign; status update
- Fix the quality map and mask refinements broken by the grid checks (#156)
- Plan: pipeline graph alongside the methods text (#158)
- Plan: redesign the UI around the QSMxT engine (#155)
- New workspace foundations (U1): vendored Preact/htm/signals, stores, protocol types, NiiVue viewer, next.html shell, smoke tests (#163)
- Run magnitude/phase pipelines through QSMxT's engine (#162)
- Run SWI and T2*/R2* through QSMxT's engine (#166)
- Settings from the engine's schema, inline in the pipeline, with the mask builder (U3) (#165)
- next.html on QSMxT's engine: live settings view, plans, mask builder and item names through the bindings (#168)
- Pipeline-graph and Command tabs for the new workspace (#167)
- Methods text beside the pipeline graph, linked to its boxes (#169)
- next.html loads scans: files, roles and the engine's scan facts (U2, part 1) (#171)
- next.html runs scans on QSMxT's engine: streamed outputs, cancel, the plan drawer (U2, part 2) (#172)
- Pipeline tab after a run: what each step did, the graph it took, and the methods text from QSMxT's run record (#170)
- next.html: re-run from here — stale steps from the engine, Re-run n steps, run history and compare (U4) (#174)
- Mask builder on QSMxT's engine: previews of the recipe, hand edits and uploads as a supplied mask (U5) (#175)
- Export panel and bundle in next.html: the engine's methods, command, settings file, graph, and the run as qsmxt writes it (U6) (#173)

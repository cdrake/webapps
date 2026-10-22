# NeuroFlow validator (WebAssembly)

`neuroflow.js` and `neuroflow_bg.wasm` are the `neuroflow-wasm` crate of
[cdrake/neuroflow](https://github.com/cdrake/neuroflow), built for the browser.
The page uses `validate_workflow_with_tools_json`: the same workflow validator
`neuroflow-mcp` runs, given the catalog's tools.

| | |
|---|---|
| Source | `cdrake/neuroflow` commit `255548d47cc35ed3a54c30f534ef3f1b1f67eac3` (`main`, the merge of cdrake/neuroflow#18) |
| Build | `wasm-pack build crates/neuroflow-wasm --release --target web --out-name neuroflow` |
| Toolchain | Rust 1.99.0, wasm-pack 0.13.1 |
| `neuroflow_bg.wasm` sha256 | `dbf3df39ebb2aa52b7908c81aee8a157be88a2918bec031b8527dacedae92b25` |
| `neuroflow.js` sha256 | `f12504a458aa0d21ab3d89de61e7d91173d8553f682aa10a6e55adf39ecef4bc` |
| Licence | MIT (`LICENSE-MIT`); NeuroFlow and every crate it links are available under MIT |

`test/vendor.test.js` checks both hashes. To update, rebuild at the new commit,
copy the three files here, and change the commit and hashes in this file and in
`src/config.js` in the same change.

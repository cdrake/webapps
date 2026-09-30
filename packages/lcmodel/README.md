# @neurodesk/lcmodel

LCModel (`exes/lcmodel`) and FID-A (`exes/fida`) compiled to one WebAssembly
module with a plain C ABI (`wasm/src/lib.rs`), and its JavaScript glue
(`src/wasm.js`). The built `src/lcmodel.wasm` is committed; after changing
either crate or `wasm/src`, run `make wasm` and `make test`.

```js
import { loadLcmodel } from "@neurodesk/lcmodel";
const lcm = await loadLcmodel(fetch(wasmUrl), { onProgress: (text, fraction) => {} });
lcm.addFile("meas.dat", bytes);          // any file FID-A can read
const { datasets } = lcm.load();          // detected and paired with water
const pre = lcm.process(0, {});           // FID-A pipeline -> .RAW/.H2O text
const fit = lcm.run({ control, files: { "spectrum.raw": pre.lcmodel.raw, "basis.basis": basis } });
```

Everything runs synchronously, so call it from a worker. `test/` checks the
module against native LCModel on its test case and runs FID-A's GE PRESS
example through preprocessing and fitting.

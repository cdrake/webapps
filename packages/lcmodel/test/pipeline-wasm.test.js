import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadLcmodel } from "../src/wasm.js";

const examples = process.env.FIDA_EXAMPLES ?? "/home/ubuntu/src/mrs/FID-A/exampleData";
const basisPath = process.env.LCMODEL_BASIS ?? `${process.env.TMPDIR}/basis-out/press-3t-te35.basis`;

async function maybeRead(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

test("GE PRESS example: FID-A preprocessing and LCModel in WebAssembly", async (t) => {
  const pfile = await maybeRead(`${examples}/GE/sample01_press/press/P17920.7`);
  const basis = await maybeRead(basisPath);
  if (!pfile || !basis) return t.skip("FID-A example data or basis set not available");
  const steps = [];
  const lcm = await loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)), {
    onProgress: (text) => steps.push(text),
  });
  lcm.addFile("P17920.7", new Uint8Array(pfile));
  const loaded = lcm.load();
  assert.equal(loaded.datasets.length, 1, JSON.stringify(loaded));
  const ds = loaded.datasets[0];
  assert.equal(ds.header.teMs, 35);
  assert.ok(ds.water, "water frames paired");
  const processed = lcm.process(0, {});
  assert.equal(processed.error, undefined, processed.error);
  assert.ok(steps.length > 0, "progress reported");
  const { lcmodel: inputs } = processed;
  const control = [
    " $LCMODL", " key=210387309", " lps=0", ` nunfil=${inputs.nunfil}`, ` deltat=${inputs.deltat}`,
    ` hzpppm=${inputs.hzpppm}`, " filbas='b.basis'", " filraw='m.raw'", " filh2o='w.h2o'", " dows=T", " doecc=T",
    " lcoord=9", " filcoo='out.coord'", " ltable=7", " filtab='out.table'", " $END", "",
  ].join("\n");
  const started = performance.now();
  const fit = lcm.run({ control, files: { "b.basis": basis.toString("utf8"), "m.raw": inputs.raw, "w.h2o": inputs.h2o } });
  console.log(`LCModel fit in WebAssembly: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  assert.equal(fit.error, null, fit.stdout);
  const naa = fit.outputs["out.table"].split("\n").find((l) => /\sNAA\s*$/.test(l));
  assert.ok(naa, "NAA row");
  console.log(naa.trim());
});

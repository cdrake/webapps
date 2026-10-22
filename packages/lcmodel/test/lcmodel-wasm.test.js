import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildControl, FILES } from "../src/lcmodel-io.js";
import { correctionFor } from "../src/tissue.js";
import { loadLcmodel } from "../src/wasm.js";

const data = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);
const read = (name) => readFile(new URL(name, data), "utf8");
const numbers = (text) => text.split("\n").filter((l) => !/LCModel \(Version|2026|Data of:/.test(l))
  .flatMap((l) => l.split(/[\s%=,]+/)).map(Number).filter((x) => l2(x));
const l2 = (x) => Number.isFinite(x);

test("WebAssembly LCModel reproduces the native test-case tables", async () => {
  const lcm = await loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)));
  const reply = lcm.run({
    control: await read("control.file"),
    files: { "3t.basis": await read("3t.basis"), "data.raw": await read("data.raw") },
    fdate: "Tue Sep 29 03:26:46 2026",
  });
  assert.equal(reply.error, null, reply.stdout);
  for (const [out, native] of [["out.table", "native.table"], ["out.coord", "native.coord"]]) {
    const got = numbers(reply.outputs[out]);
    const want = numbers(await read(native));
    assert.equal(got.length, want.length, out);
    let worst = 0;
    got.forEach((g, k) => { worst = Math.max(worst, Math.abs(g - want[k]) / Math.max(Math.abs(want[k]), 1e-30)); });
    console.log(`${out}: ${got.length} numbers, worst relative difference ${worst.toExponential(2)}`);
    assert.ok(worst <= 1e-3, `${out} differs by ${worst}`);
  }
});

test("tissue correction uses the calibration of the actual PRESS and MEGA-PRESS fits", async () => {
  const lcm = await loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)));
  const files = { [FILES.basis]: await read("3t.basis"), [FILES.raw]: await read("data.raw") };
  for (const edited of [false, true]) {
    const control = buildControl({ nunfil: 1024, deltat: 0.0005, hzpppm: 123, sptype: edited ? "mega-press-3" : "" })
      .replace(" $END", " lprint=8\n filpri='calibration.print'\n $END");
    const reply = lcm.run({ control, files });
    assert.equal(reply.error, null, reply.stdout);
    const correction = correctionFor([{ name: "GABA", concentration: 1.2 }], {
      fractions: { gm: 0.6, wm: 0.27, csf: 0.13 },
      header: { fieldT: 3, teMs: 68, trMs: 2000 },
      waterScaled: true,
      edited,
      metaboliteRelaxation: true,
    });
    for (const [name, expected] of Object.entries(correction.constants.lcmodel)) {
      const printed = Number(reply.outputs["calibration.print"].match(new RegExp(`${name}=\\s*([\\d.eE+-]+)`, "i"))?.[1]);
      // LCModel stores its calibration in f32; tissue correction uses doubles.
      assert.ok(Math.abs(printed - expected) < expected * 1e-7, `${name}: fitted ${printed}, corrected ${expected}`);
    }
  }
});

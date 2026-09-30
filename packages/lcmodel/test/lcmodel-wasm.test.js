import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

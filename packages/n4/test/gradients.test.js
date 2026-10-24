// n4's copy of the b-value rules must give dwi2trx's results, so the app, the command line and
// the other DWI apps pick the same b0 volumes and refuse the same bval files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as shared from "@neurodesk/dwi2trx/gradients";
import { B0_THRESHOLD, b0Volumes, parseBval } from "../src/gradients.js";

const crate = new URL("../../../exes/dwi/gradients/", import.meta.url);
const read = (path) => readFileSync(new URL(path, crate), "utf8");

const outcome = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: error.message };
  }
};

test("parseBval accepts and refuses what dwi2trx's parseBval does, with the same messages", () => {
  const cases = [
    ["0 1000\t1000\n2000\n", 4],
    ["0 1000", undefined],
    ["  ", 1],
    ["0 abc", 2],
    ["0 Infinity", 2],
    ["0 -5", 2],
    ["0 1000", 3],
    ["0 1e3 5e1 49.999", 4],
  ];
  for (const [text, frames] of cases) {
    assert.deepEqual(outcome(() => parseBval(text, frames)), outcome(() => shared.parseBval(text, frames)), JSON.stringify(text));
  }
});

test("b0Volumes selects and refuses what dwi2trx's b0Volumes does", () => {
  assert.equal(B0_THRESHOLD, shared.B0_THRESHOLD);
  const cases = [
    [[0, 1000, 5, 2000], 4],
    [null, 3],
    [[1000, 2000], 2],
    [[0, -1], 2],
    [[0, NaN], 2],
    [[0, Infinity], 2],
    [[49.999, 50, 50.001], 3],
  ];
  for (const [bvals, frames] of cases) {
    assert.deepEqual(outcome(() => b0Volumes(bvals, frames)), outcome(() => shared.b0Volumes(bvals, frames)), String(bvals));
  }
});

test("b0Volumes agrees with the gradients crate on its shared cases", () => {
  const cases = read("tests/data/b0-rule.tsv")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t").map((field) => field.split(/\s+/).filter(Boolean).map(Number)));
  assert.ok(cases.length > 0);
  for (const [bvals, b0] of cases) {
    if (b0.length) assert.deepEqual(b0Volumes(bvals, bvals.length), b0, bvals.join(" "));
    else assert.throws(() => b0Volumes(bvals, bvals.length), /no b0 volume/, bvals.join(" "));
  }
  const sub107 = parseBval(read("tests/data/sub-107_dir-AP_dwi.bval"), 101);
  assert.deepEqual(b0Volumes(sub107, sub107.length), shared.b0Volumes(sub107, sub107.length));
});

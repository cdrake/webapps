import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { N4_MODULE_SHA256, N4_WASM_SHA256 } from "../src/pin.js";

const sha256 = async (name) => createHash("sha256").update(await readFile(new URL(`../wasm/${name}`, import.meta.url))).digest("hex");

test("the committed module is the pinned build", async () => {
  assert.equal(await sha256("n4-bias.wasm"), N4_WASM_SHA256);
  assert.equal(await sha256("n4-bias.mjs"), N4_MODULE_SHA256);
});

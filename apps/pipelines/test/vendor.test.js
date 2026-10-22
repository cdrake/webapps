// The vendored validator is the build vendor/neuroflow/README.md pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { VALIDATOR } from "../src/config.js";

const vendor = new URL("../vendor/neuroflow/", import.meta.url);
const readme = await readFile(new URL("README.md", vendor), "utf8");
const sha256 = async (name) => createHash("sha256").update(await readFile(new URL(name, vendor))).digest("hex");
const pinned = (name) => new RegExp(`\`${name.replace(".", "\\.")}\` sha256 \\| \`([0-9a-f]{64})\``).exec(readme)?.[1];

test("both vendored files match the hashes in the README", async () => {
  for (const name of ["neuroflow_bg.wasm", "neuroflow.js"]) assert.equal(await sha256(name), pinned(name), name);
});

test("config names the same commit and WebAssembly build", async () => {
  assert.ok(readme.includes(VALIDATOR.commit));
  assert.equal(VALIDATOR.sha256, await sha256("neuroflow_bg.wasm"));
});

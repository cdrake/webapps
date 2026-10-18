// DOM-independent unit test (Node, no browser). Browser behaviour is covered by the
// Playwright test in e2e/ — Node tests must not import modules that touch `document`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));

test("each example fills the fixed and the moving image from the shared registration dataset", () => {
  for (const example of examples) {
    assert.deepEqual(example.files.map(({ role }) => role), ["fixed", "moving"]);
    assert.ok(example.files.every(({ url }) => /\/resolve\/[0-9a-f]{40}\/reg\//.test(url)));
  }
});

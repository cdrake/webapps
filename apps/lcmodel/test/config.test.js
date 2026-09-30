import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { APP, basisLibrary } from "../src/config.js";

test("app identity", () => {
  assert.equal(APP.id, "lcmodel");
});

test("every basis set in the manifest has a pinned, checksummed asset", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../models/lcmodel.manifest.json", import.meta.url), "utf8"));
  const library = basisLibrary(manifest);
  assert.equal(library.length, 9);
  for (const set of library) {
    assert.match(set.library.url, new RegExp(`/resolve/${manifest.revision}/lcmodel/basis/${set.id}\\.basis\\.gz$`));
    assert.match(set.library.sha256, /^[0-9a-f]{64}$/);
    assert.ok(set.hzpppm > 60 && set.teMs > 0 && set.sequence);
  }
});

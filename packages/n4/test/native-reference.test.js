// The module against native ANTs 2.6.5 N4BiasFieldCorrection (#436): the mean b0 of the ds005134
// slab, weighted by the app's default MindGrab mask, with dwibiascorrect's options. Data-gated:
// N4_REFERENCE names the folder that validation/fetch-reference.mjs fills; without it the test
// does nothing, unless N4_REQUIRE_REFERENCE is set (as in CI): then missing data is a failure.
// The module gives native's field byte for byte today, so the gate is exact equality.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createN4, inflateNifti } from "../src/index.js";

/** The float32 voxels of a NIfTI-1 file (gzipped or not). */
async function voxels(bytes) {
  const raw = await inflateNifti(bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  assert.equal(view.getInt16(70, true), 16, "float32 data");
  const offset = view.getFloat32(108, true);
  return new Float32Array(raw.slice(offset).buffer);
}

test("the bias field equals native ANTs N4 on the ds005134 slab", async (t) => {
  const folder = process.env.N4_REFERENCE;
  if (!folder) {
    assert.ok(!process.env.N4_REQUIRE_REFERENCE, "N4_REFERENCE is not set, but N4_REQUIRE_REFERENCE is set");
    t.skip("N4_REFERENCE is not set");
    return;
  }
  const read = (name) => readFile(join(folder, name));
  const { default: createModule } = await import("../wasm/n4-bias.mjs");
  const n4 = await createN4({ createModule, wasmBinary: await readFile(new URL("../wasm/n4-bias.wasm", import.meta.url)) });
  const { bias, corrected } = await n4.correct({ image: await read("meanb0.nii.gz"), weight: await read("mindgrab_mask.nii.gz") });
  const field = await voxels(bias);
  const native = await voxels(await read("native_bias.nii.gz"));
  assert.equal(field.length, 67 * 92 * 10);
  assert.deepEqual(field, native, "bias field");
  assert.deepEqual(await voxels(corrected), await voxels(await read("native_corrected.nii.gz")), "corrected mean b0");
});

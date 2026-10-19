// The niimath dtifit option through the real dtifit-enabled niimath WASM in Node: it fits the
// same volumes as the WebAssembly tensor fit, and its FA and MD equal DWI2TRX's fit of those
// volumes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { fitTensor } from "@neurodesk/dwi2trx";
import { parseBvalBvec } from "@neurodesk/dwi2trx/gradients";
import { runNiimath } from "@neurodesk/dwi2trx/runner";
import { loadNoddi } from "@neurodesk/noddi";
import { readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { syntheticDwi, syntheticMask } from "../e2e/fixtures.mjs";
import { fitDtifit } from "../src/dtifit.js";

const noddi = await loadNoddi(readFileSync(new URL(import.meta.resolve("@neurodesk/noddi/wasm"))));

/** The app's view of a synthetic DWI, as readDwi gives it. */
function appInput(dwi) {
  const [image, bval, bvec] = dwi.files;
  const buffer = gunzipSync(image.buffer);
  const frames = readNiftiFrames(buffer);
  const { bvals, bvecs } = parseBvalBvec(bval.buffer.toString(), bvec.buffer.toString());
  const table = noddi.describe(bvals, bvecs);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return { buffer: arrayBuffer, data: frames.data, dims: frames.dims, bvals, bvecs, volumes: table.dtiVolumes };
}

/** DWI2TRX's fit of a DWI's files, as its tensor worker runs it. */
async function dwi2trxFit(dwi, mask) {
  const [image, bval, bvec] = dwi.files;
  const maps = await fitTensor(runNiimath, { dwi: image.buffer, bval: bval.buffer, bvec: bvec.buffer, mask: mask?.buffer });
  return { FA: readNiftiFrames(gunzipSync(maps.FA)).data, MD: readNiftiFrames(gunzipSync(maps.MD)).data };
}

test("FA and MD equal DWI2TRX's on a single-shell DWI, where the fit uses every volume", async () => {
  // Three distinct eigenvalues along x, y and z: with two equal ones, the pinned niimath build
  // gives a V1 up to 14 degrees from the first eigenvector, although its eigenvalues are right.
  const dwi = syntheticDwi({ shells: [1000], eigenvalues: [1.7e-3, 0.6e-3, 0.3e-3] });
  const input = appInput(dwi);
  assert.equal(input.volumes.length, input.bvals.length);
  const mask = Uint8Array.from(readNiftiFrames(gunzipSync(syntheticMask({ value: 1 }).buffer)).data);
  const maps = await fitDtifit(runNiimath, { ...input, data: null, mask });
  const reference = await dwi2trxFit(dwi, syntheticMask({ value: 1 }));
  assert.deepEqual(maps.FA, reference.FA);
  assert.deepEqual(maps.MD, reference.MD);
  const centre = 4 + 8 * (4 + 8 * 4);
  assert.ok(Math.abs(maps.AD[centre] - 1.7e-3) < 1e-5, `AD ${maps.AD[centre]}`);
  assert.ok(Math.abs(maps.RD[centre] - 0.45e-3) < 1e-5, `RD ${maps.RD[centre]}`);
  assert.ok(Math.abs(maps.S0[centre] - 1000) < 1, `S0 ${maps.S0[centre]}`);
  // niimath's default -xflip auto flips x on this grid (positive sform determinant): V1 is (-1, 0, 0).
  assert.ok(Math.abs(maps.V1x[centre] + 1) < 1e-4, `V1x ${maps.V1x[centre]}`);
  assert.ok(Math.abs(maps.V1y[centre]) < 1e-4 && Math.abs(maps.V1z[centre]) < 1e-4);
});

test("on a two-shell DWI the fit uses the b0 volumes and b = 1000 only, as DWI2TRX's fit of them", async () => {
  const input = appInput(syntheticDwi({ shells: [1000, 2000] }));
  assert.equal(input.volumes.length, 32);
  const maps = await fitDtifit(runNiimath, { ...input, mask: null });
  // syntheticDwi with one shell holds exactly those volumes, in the same order.
  const reference = await dwi2trxFit(syntheticDwi({ shells: [1000] }));
  assert.deepEqual(maps.FA, reference.FA);
  assert.deepEqual(maps.MD, reference.MD);
});

test("voxels outside the mask stay zero", async () => {
  const input = appInput(syntheticDwi({ shells: [1000] }));
  const voxels = input.dims[0] * input.dims[1] * input.dims[2];
  const centre = 4 + 8 * (4 + 8 * 4);
  const mask = new Uint8Array(voxels);
  mask[centre] = 1;
  const maps = await fitDtifit(runNiimath, { ...input, data: null, mask });
  assert.ok(maps.FA[centre] > 0.5);
  for (const name of ["FA", "MD", "AD", "RD", "S0"]) {
    assert.equal(maps[name].reduce((count, value, i) => count + (i !== centre && value !== 0 ? 1 : 0), 0), 0, name);
  }
});

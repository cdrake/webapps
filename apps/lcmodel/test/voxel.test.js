import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { decodeNiftiBuffer, parseNiftiVolume } from "@neurodesk/webapp-components/file-io";
import { voxelWeights } from "@neurodesk/lcmodel/voxel";

// The geometry itself is specified in packages/lcmodel/test/voxel.test.js.
// Osprey's own voxel mask for its twix example (MIT, exampledata/twix/UnEdited/
// sub-01, ses-01_T1w_overlay.nii.gz), with the voxel spec2nii writes for
// sub-01_PRESS30.dat (exes/fida/tests/geometry.rs checks the reader gives it).
const osprey = process.env.OSPREY_EXAMPLES;
const anat = osprey && `${osprey}/twix/UnEdited/sub-01/ses-01/anat/sub-01`;
test("the twix voxel matches Osprey's own mask of it", { skip: !(anat && existsSync(`${anat}/ses-01_T1w_overlay.nii.gz`)) && "set OSPREY_EXAMPLES" }, async () => {
  const mask = parseNiftiVolume(await decodeNiftiBuffer(readFileSync(`${anat}/ses-01_T1w_overlay.nii.gz`)));
  const twixVoxel = [
    [29.999996, 0.000318, -0.016325, -4.395912],
    [-0.000318, -29.977212, -1.169079, 8.7819],
    [-0.016325, 1.169079, -29.977208, 58.784504],
    [0, 0, 0, 1],
  ];
  const dice = (weights) => {
    let both = 0;
    let ours = 0;
    let theirs = 0;
    for (let i = 0; i < weights.length; i += 1) {
      const a = weights[i] >= 0.5;
      const b = mask.imageData[i] > 0.5;
      both += a && b;
      ours += a;
      theirs += b;
    }
    return (2 * both) / (ours + theirs);
  };
  const exact = voxelWeights(twixVoxel, { affine: mask.affine, dims: mask.dims });
  assert.ok(Math.abs(exact.volumeMm3 - 27000) < 50, `volume ${exact.volumeMm3}`);
  // Osprey's coreg_siemens shifts the T1's voxel centres by half a voxel
  // (-0.5, -0.5, +0.5 mm here), taking SPM's centres for corners, so its mask
  // sits half a voxel off: 1.5 mm of a 30 mm cube.
  assert.ok(dice(exact.weights) > 0.94, `Dice ${dice(exact.weights)}`);
  const shifted = mask.affine.map((row, r) => Array.from(row).map((v, c) => (c === 3 && r < 3 ? v + [-0.5, -0.5, 0.5][r] : v)));
  const asOsprey = voxelWeights(twixVoxel, { affine: shifted, dims: mask.dims });
  // The shift puts the box's faces near voxel centres, so its face layers weigh
  // about 1/2 and fall either side of the 0.5 threshold: Dice 0.993.
  assert.ok(dice(asOsprey.weights) > 0.99, `Dice with Osprey's shift ${dice(asOsprey.weights)}`);
});

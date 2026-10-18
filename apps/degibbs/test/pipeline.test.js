import assert from "node:assert/strict";
import { test } from "node:test";
import { derivativeSidecar, outputNames, splitName } from "../src/pipeline.js";

test("derivative names keep the BIDS suffix and add desc-degibbs", () => {
  assert.deepEqual(splitName("sub-01_dir-AP_dwi.nii.gz"), ["sub-01_dir-AP", "dwi"]);
  assert.deepEqual(outputNames("sub-01_dir-AP_dwi.nii.gz"), {
    image: "sub-01_dir-AP_desc-degibbs_dwi.nii.gz",
    bval: "sub-01_dir-AP_desc-degibbs_dwi.bval",
    bvec: "sub-01_dir-AP_desc-degibbs_dwi.bvec",
    sidecar: "sub-01_dir-AP_desc-degibbs_dwi.json",
  });
  assert.equal(outputNames("data.nii").image, "data_desc-degibbs.nii.gz");
});

test("the derivative sidecar keeps the input's fields", () => {
  const out = derivativeSidecar({ PhaseEncodingDirection: "j-" });
  assert.equal(out.PhaseEncodingDirection, "j-");
  assert.match(out.Description, /mrdegibbs/);
  assert.match(derivativeSidecar(null).Description, /subvoxel/);
});

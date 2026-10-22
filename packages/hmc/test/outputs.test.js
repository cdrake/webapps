import assert from "node:assert/strict";
import test from "node:test";
import { derivativeSidecar, outputNames, sidecarText, splitName } from "../src/outputs.js";

test("output names follow the BIDS-derivative form of the other DWI apps", () => {
  const names = outputNames("sub-01_ses-02_acq-multi_dir-AP_dwi.nii.gz");
  assert.equal(names.image, "sub-01_ses-02_acq-multi_dir-AP_desc-hmc_dwi.nii.gz");
  assert.equal(names.bval, "sub-01_ses-02_acq-multi_dir-AP_desc-hmc_dwi.bval");
  assert.equal(names.bvec, "sub-01_ses-02_acq-multi_dir-AP_desc-hmc_dwi.bvec");
  assert.equal(names.sidecar, "sub-01_ses-02_acq-multi_dir-AP_desc-hmc_dwi.json");
  assert.equal(names.motion, "sub-01_ses-02_acq-multi_dir-AP_desc-hmc_motion.tsv");
  assert.equal(names.transform(7), "sub-01_ses-02_acq-multi_dir-AP_vol-0007_desc-hmc_xfm.mat");
  assert.equal(names.transform(100), "sub-01_ses-02_acq-multi_dir-AP_vol-0100_desc-hmc_xfm.mat");
  // An earlier desc- label is replaced; a name without a suffix becomes a dwi.
  assert.equal(outputNames("sub-01_desc-denoised_dwi.nii").image, "sub-01_desc-hmc_dwi.nii.gz");
  assert.equal(outputNames("scan.nii.gz").image, "scan_desc-hmc_dwi.nii.gz");
  assert.equal(outputNames("data/sub-01_dwi.nii").motion, "sub-01_desc-hmc_motion.tsv");
  assert.deepEqual(splitName("sub-01_dwi.nii.gz"), ["sub-01", "dwi"]);
});

test("the sidecar keeps the input's fields and holds no time", () => {
  const sidecar = derivativeSidecar({ PhaseEncodingDirection: "j-" }, { method: "nifreeze", registered: 90, volumes: 101 });
  assert.equal(sidecar.PhaseEncodingDirection, "j-");
  assert.equal(sidecar.HeadMotionCorrection.Volumes, 101);
  assert.match(sidecar.HeadMotionCorrection.Resampling, /BSpline$/);
  assert.equal(sidecarText(sidecar), sidecarText(derivativeSidecar({ PhaseEncodingDirection: "j-" }, { method: "nifreeze", registered: 90, volumes: 101 })));
  assert.ok(sidecarText(sidecar).endsWith("}\n"));
});

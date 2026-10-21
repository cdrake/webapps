import { test } from "node:test";
import assert from "node:assert/strict";
import * as pipeline from "../src/pipeline.js";

const TRT = 0.05;

function files(entries, folder = "dataset") {
  return Object.entries(entries).map(([path, content]) => {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const file = new File([text], path.split("/").pop());
    Object.defineProperty(file, "webkitRelativePath", { value: `${folder}/${path}` });
    return file;
  });
}

function run(subject = "01", number = "1") {
  const stem = `sub-${subject}_ses-1_run-${number}_dwi`;
  const path = `sub-${subject}/ses-1/dwi/${stem}`;
  return {
    [`${path}.nii.gz`]: "",
    [`${path}.json`]: { PhaseEncodingDirection: "j-", TotalReadoutTime: TRT },
    [`${path}.bval`]: "0",
  };
}

function fieldmap(direction, intendedFor, subject = "01", number = "1") {
  const stem = `sub-${subject}_ses-1_dir-${direction}_run-${number}_epi`;
  const path = `sub-${subject}/ses-1/fmap/${stem}`;
  return {
    [`${path}.nii.gz`]: "",
    [`${path}.json`]: {
      PhaseEncodingDirection: direction === "AP" ? "j-" : "j",
      TotalReadoutTime: TRT,
      IntendedFor: intendedFor,
    },
  };
}

test("a BIDS DWI and its IntendedFor fieldmaps select the reverse-PE fieldmap pair", async () => {
  const target = "ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz";
  const pair = await pipeline.selectBidsPair(files({ ...run(), ...fieldmap("AP", target), ...fieldmap("PA", target) }));
  assert.deepEqual(pair.map((entry) => entry.image.name), [
    "sub-01_ses-1_dir-AP_run-1_epi.nii.gz",
    "sub-01_ses-1_dir-PA_run-1_epi.nii.gz",
  ]);
  assert.deepEqual(pair.map((entry) => entry.sidecar.TotalReadoutTime), [0.05, 0.05]);
});

for (const target of [
  ["ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz"],
  "bids::sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz",
  ["bids::/sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz", "ses-1/func/sub-01_ses-1_bold.nii.gz"],
]) {
  test(`IntendedFor resolves ${JSON.stringify(target)}`, async () => {
    const pair = await pipeline.selectBidsPair(files({ ...run(), ...fieldmap("AP", target), ...fieldmap("PA", target) }));
    assert.deepEqual(pair.map((entry) => entry.image.name), [
      "sub-01_ses-1_dir-AP_run-1_epi.nii.gz",
      "sub-01_ses-1_dir-PA_run-1_epi.nii.gz",
    ]);
  });
}

test("flat BIDS files use their declared entities and the same shared IntendedFor reader", async () => {
  const target = "bids::sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz";
  const selection = files({ ...run(), ...fieldmap("AP", target), ...fieldmap("PA", target) });
  const flat = selection.map((file) => new File([file], file.name));
  const pair = await pipeline.selectBidsPair(flat);
  assert.deepEqual(pair.map((entry) => entry.image.name), [
    "sub-01_ses-1_dir-AP_run-1_epi.nii.gz",
    "sub-01_ses-1_dir-PA_run-1_epi.nii.gz",
  ]);
  assert.ok(flat.every((file) => !file.webkitRelativePath));
});

test("a single reverse fieldmap pairs with the DWI named by IntendedFor", async () => {
  const target = "ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz";
  const pair = await pipeline.selectBidsPair(files({ ...run(), ...fieldmap("PA", target) }));
  assert.deepEqual(pair.map((entry) => entry.image.name), [
    "sub-01_ses-1_run-1_dwi.nii.gz",
    "sub-01_ses-1_dir-PA_run-1_epi.nii.gz",
  ]);
});

test("one fieldmap pair shared by two DWI runs is one unambiguous pair", async () => {
  const target = ["ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz", "ses-1/dwi/sub-01_ses-1_run-2_dwi.nii.gz"];
  const pair = await pipeline.selectBidsPair(files({ ...run(), ...run("01", "2"), ...fieldmap("AP", target), ...fieldmap("PA", target) }));
  assert.deepEqual(pair.map((entry) => entry.image.name), [
    "sub-01_ses-1_dir-AP_run-1_epi.nii.gz",
    "sub-01_ses-1_dir-PA_run-1_epi.nii.gz",
  ]);
});

test("different IntendedFor pairs are refused instead of selecting one run", async () => {
  const first = "ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz";
  const second = "ses-1/dwi/sub-01_ses-1_run-2_dwi.nii.gz";
  const selection = files({
    ...run(),
    ...run("01", "2"),
    ...fieldmap("AP", first),
    ...fieldmap("PA", first),
    ...fieldmap("AP", second, "01", "2"),
    ...fieldmap("PA", second, "01", "2"),
  });
  await assert.rejects(pipeline.selectBidsPair(selection), /more than one reverse pair/);
});

test("IntendedFor cannot associate a fieldmap from another subject", async () => {
  const target = "bids::sub-01/ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz";
  await assert.rejects(pipeline.selectBidsPair(files({ ...run(), ...fieldmap("PA", target, "02") })), /same subject/);
  await assert.rejects(pipeline.selectBidsPair(files({ ...run(), ...run("02") })), /one subject and dataset/);
});

test("two loose images from different subjects are refused", () => {
  const series = [
    { image: { name: "sub-01_dir-AP_dwi.nii.gz" }, sidecar: { PhaseEncodingDirection: "j-", TotalReadoutTime: TRT } },
    { image: { name: "sub-02_dir-PA_epi.nii.gz" }, sidecar: { PhaseEncodingDirection: "j", TotalReadoutTime: TRT } },
  ];
  assert.throws(() => pipeline.selectPair(series), /same subject/);
});

test("duplicate flat BIDS paths are refused instead of merging conflicting sidecars", async () => {
  const target = "ses-1/dwi/sub-01_ses-1_run-1_dwi.nii.gz";
  const selection = files({ ...run(), ...fieldmap("PA", target) }).map((file) => new File([file], file.name));
  selection.push(new File(["{}"], "sub-01_ses-1_run-1_dwi.json"));
  await assert.rejects(pipeline.selectBidsPair(selection), /Repeated BIDS input path/);
});

test("non-BIDS inputs stay at the shared loose-image and DICOM boundary", async () => {
  assert.equal(await pipeline.selectBidsPair([new File([""], "image.dcm")]), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadLcmodel } from "../src/wasm.js";

function nifti({ anatomy = false, te = 0.03, frequency = 123.25, dwell = 0.0005 } = {}) {
  const json = Buffer.from(JSON.stringify({ SpectrometerFrequency: [frequency], ResonantNucleus: ["1H"], EchoTime: te, RepetitionTime: 2 }));
  const extensionSize = Math.ceil((json.length + 8) / 16) * 16;
  const offset = anatomy ? 352 : 352 + extensionSize;
  const bytes = Buffer.alloc(offset + 128 * 8);
  bytes.writeInt32LE(348);
  [4, 1, 1, 1, 128, 1, 1, 1].forEach((d, i) => bytes.writeInt16LE(d, 40 + i * 2));
  bytes.writeInt16LE(anatomy ? 16 : 32, 70);
  bytes.writeFloatLE(dwell, 92);
  bytes.writeFloatLE(offset, 108);
  bytes.write("n+1\0", 344);
  if (!anatomy) {
    bytes[348] = 1;
    bytes.writeInt32LE(extensionSize, 352);
    bytes.writeInt32LE(44, 356);
    json.copy(bytes, 360);
  }
  for (let i = 0; i < 128; i++) bytes.writeFloatLE(Math.exp(-i / 32), offset + i * 8);
  return bytes;
}

async function moduleWith(files) {
  const lcm = await loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)));
  for (const [name, bytes] of files) lcm.addFile(name, bytes);
  return lcm;
}

test("public load separates anatomy and preserves neutral water paths and timing", async () => {
  const files = [["subject/T1.nii", nifti({ anatomy: true })], ["subject/metab.nii", nifti()], ["reference/scan.nii", nifti({ te: 0.015 })]];
  const lcm = await moduleWith(files);
  const result = lcm.load({ water: [{ targetPath: "subject/metab.nii", files: ["reference/scan.nii"] }] });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.images, [{ name: "T1", files: ["subject/T1.nii"] }]);
  assert.equal(result.datasets.length, 1);
  assert.equal(result.datasets[0].path, "subject/metab.nii");
  assert.equal(result.datasets[0].waterPath, "reference/scan.nii");
  assert.equal(result.datasets[0].header.waterTeMs, 15);
  const processed = lcm.process(0, { driftCorrection: false });
  assert.equal(processed.error, undefined);
  assert.match(processed.lcmodel.h2o, /\$NMID/);
});

test("anatomy-only loads return images without a spectroscopy dataset", async () => {
  const lcm = await moduleWith([["T1.nii", nifti({ anatomy: true })]]);
  const result = lcm.load();
  assert.deepEqual(result.datasets, []);
  assert.deepEqual(result.images, [{ name: "T1", files: ["T1.nii"] }]);
});

test("explicit water rejects ambiguous references, missing names, and incompatible sampling", async () => {
  for (const [waterFiles, reference, message] of [
    [["one.nii", "two.nii"], nifti(), /exactly one/],
    [["missing.nii"], nifti(), /missing/],
    [["one.nii"], nifti({ dwell: 0.001 }), /dwell time/],
    [["one.nii"], nifti({ frequency: 300 }), /frequency/],
  ]) {
    const lcm = await moduleWith([["metab.nii", nifti()], ["one.nii", reference], ["two.nii", nifti()]]);
    const result = lcm.load({ water: [{ targetPath: "metab.nii", files: waterFiles }] });
    assert.match(result.error, message);
  }
});

test("a malformed NIfTI-MRS extension remains a spectroscopy error", async () => {
  const broken = nifti();
  broken.fill(120, 360, broken.readFloatLE(108));
  const lcm = await moduleWith([["broken.nii", broken]]);
  const result = lcm.load();
  assert.deepEqual(result.images, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /JSON/);
});

function dicom({ image = false, series = "1", description = "press", study = "study", patient = "patient", seriesNumber, voiZ } = {}) {
  const preamble = Buffer.alloc(132);
  preamble.write("DICM", 128);
  const tag = (group, element, vr, value) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value.padEnd(Math.ceil(value.length / 2) * 2));
    const header = Buffer.alloc(vr === "OF" ? 12 : 8);
    header.writeUInt16LE(group);
    header.writeUInt16LE(element, 2);
    header.write(vr, 4);
    if (vr === "OF") header.writeUInt32LE(data.length, 8);
    else header.writeUInt16LE(data.length, 6);
    return Buffer.concat([header, data]);
  };
  const spectrum = Buffer.alloc(128 * 8);
  for (let i = 0; i < 128; i++) spectrum.writeFloatLE(Math.exp(-i / 32), i * 8);
  const geometry = voiZ === undefined ? "" : `sSpecPara.sVoI.dReadoutFOV = 20\nsSpecPara.sVoI.dPhaseFOV = 20\nsSpecPara.sVoI.dThickness = 20\nsSpecPara.sVoI.sPosition.dTra = ${voiZ}\n`;
  const protocol = `ASCCONV BEGIN\nlVectorSize = 128\nalDwellTime[0] = 500000\nlFrequency = 123250000\nflNominalB0 = 3\nalTE[0] = 30000\nalTR[0] = 2000000\ntSequenceFileName = svs_se\n${geometry}ASCCONV END\n`;
  return Buffer.concat([
    preamble,
    tag(0x20, 0x0d, "UI", study),
    tag(0x20, 0x0e, "UI", series),
    ...(seriesNumber === undefined ? [] : [tag(0x20, 0x11, "IS", String(seriesNumber))]),
    tag(0x10, 0x20, "LO", patient),
    tag(8, 0x103e, "LO", description),
    image ? tag(8, 0x60, "CS", "MR") : tag(0x5600, 0x20, "OF", spectrum),
    tag(0x29, 0x1020, "LO", protocol),
  ]);
}

test("Siemens water sharing preserves hyphenated protocol parameters", async () => {
  for (const described of [true, false]) {
    const files = [
      ["session/sub-01-20-PRESS-30-TE_ave/1.dcm", "PRESS-30-TE_ave"],
      ["session/sub-01-21-PRESS-30-TE/1.dcm", "PRESS-30-TE"],
      ["session/sub-01-22-PRESS-30-TE_water_off/1.dcm", "PRESS-30-TE_water_off"],
      ["session/sub-01-23-PRESS-144-TE/1.dcm", "PRESS-144-TE"],
    ].map(([name, description], i) => [name, dicom({ series: String(20 + i), seriesNumber: 20 + i, description: described ? description : "" })]);
    const lcm = await moduleWith(files);
    const result = lcm.load();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.datasets.map(d => [d.path, d.waterPath ?? null]), [
      ["session/sub-01-20-PRESS-30-TE_ave/1.dcm", "session/sub-01-22-PRESS-30-TE_water_off/1.dcm"],
      ["session/sub-01-21-PRESS-30-TE/1.dcm", "session/sub-01-22-PRESS-30-TE_water_off/1.dcm"],
      ["session/sub-01-23-PRESS-144-TE/1.dcm", null],
    ]);
  }
});

test("Siemens water sharing refuses a different Siemens VOI", async () => {
  const files = [
    ["session/sub-01-20-PRESS/1.dcm", "PRESS", 0],
    ["session/sub-01-21-PRESS_ave/1.dcm", "PRESS_ave", 0],
    ["session/sub-01-22-PRESS_water_off/1.dcm", "PRESS_water_off", 0],
    ["session/sub-01-23-PRESS/1.dcm", "PRESS", 40],
  ].map(([name, description, voiZ], i) => [name, dicom({ series: String(20 + i), description, voiZ })]);
  const lcm = await moduleWith(files);
  const result = lcm.load();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.datasets.map(d => [d.path, d.waterPath ?? null]), [
    ["session/sub-01-20-PRESS/1.dcm", "session/sub-01-22-PRESS_water_off/1.dcm"],
    ["session/sub-01-21-PRESS_ave/1.dcm", "session/sub-01-22-PRESS_water_off/1.dcm"],
    ["session/sub-01-23-PRESS/1.dcm", null],
  ]);
  assert.deepEqual(result.datasets[0].header.voxel.centerMm, [-0, -0, 0]);
  assert.deepEqual(result.datasets[2].header.voxel.centerMm, [-0, -0, 40]);
});

test("mixed flat DICOM exports load each spectroscopy series in either file order", async () => {
  const files = [["flat/image.dcm", dicom({ image: true, series: "image", description: "T1" })], ["flat/metab.dcm", dicom()], ["flat/reference.dcm", dicom({ series: "water", description: "press_ref" })]];
  for (const ordered of [files, [...files].reverse()]) {
    const lcm = await moduleWith(ordered);
    const result = lcm.load();
    assert.equal(result.datasets.length, 1, JSON.stringify(result));
    assert.equal(result.datasets[0].waterPath, "flat/reference.dcm");
    assert.deepEqual(result.images, [{ name: "T1", files: ["flat/image.dcm"] }]);
    assert.deepEqual(result.errors, []);
  }
});

test("explicit DICOM assignment accepts a neutral name and refuses conflicting identity", async () => {
  for (const [identity, error] of [[{}, false], [{ study: "other" }, true], [{ patient: "other" }, true]]) {
    const lcm = await moduleWith([["metab.dcm", dicom()], ["neutral.dcm", dicom({ series: "water", description: "reference", ...identity })]]);
    const result = lcm.load({ water: [{ targetPath: "metab.dcm", files: ["neutral.dcm"] }] });
    if (error) assert.match(result.error, /study or patient/);
    else {
      assert.equal(result.datasets.length, 1, JSON.stringify(result));
      assert.equal(result.datasets[0].waterPath, "neutral.dcm");
      assert.match(lcm.process(0, { driftCorrection: false }).lcmodel.h2o, /\$NMID/);
    }
  }
});

test("explicit water can cross reader formats despite NIfTI-1 dwell-time rounding", async () => {
  const lcm = await moduleWith([["metab.dcm", dicom()], ["neutral.nii", nifti({ te: 0.015 })]]);
  const result = lcm.load({ water: [{ targetPath: "metab.dcm", files: ["neutral.nii"] }] });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.datasets[0].header.waterTeMs, 15);
  assert.match(lcm.process(0, { driftCorrection: false }).lcmodel.h2o, /\$NMID/);
});

test("explicit target overrides a water filename's automatic partner", async () => {
  const lcm = await moduleWith([["a.nii", nifti()], ["b.nii", nifti()], ["a_ref.nii", nifti({ te: 0.015 })]]);
  const result = lcm.load({ water: [{ targetPath: "b.nii", files: ["a_ref.nii"] }] });
  assert.equal(result.error, undefined);
  assert.equal(result.datasets.length, 2);
  assert.equal(result.datasets[0].water, null);
  assert.equal(result.datasets[1].waterPath, "a_ref.nii");
  assert.equal(result.datasets[1].header.waterTeMs, 15);
  assert.deepEqual(result.unpairedWater, []);
});

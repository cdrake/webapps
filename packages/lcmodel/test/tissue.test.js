import test from "node:test";
import assert from "node:assert/strict";
import { correctConcentrations, correctedCsv, correctionFor, metaboliteRelaxation, normalizeFractions, fieldKey, tissueTexts } from "../src/tissue.js";

// Osprey's own quantTiss and quantAlpha (OspreyQuantify.m at 98b2e354,
// lines 723-803, 972-1067 and lookUpRelaxTimes 1073-1171, extracted verbatim)
// run in GNU Octave 11.1. LCModel's water_scale and area_met_norm (basis.rs;
// LCModel manual section 10.2.1) imply amplWater = WCONC * ATTH2O / ATTMET
// = 35880 * 0.7. This intentionally differs from Osprey's LCModel import,
// which inverts the attenuation factors. Osprey's own fits use ATTH2O = 1.
const NAMES = ["NAA", "Cr", "GPC", "mI", "Glu", "GABA", "Gln", "Glx", "tNAA", "Lac", "Unknown", "GABAplus"];
const CONC = [10.5, 8.2, 1.9, 6.3, 9.1, 1.2, 3.3, 12.4, 12.0, 0.4, 1.0, 1.5];
const FRACTIONS = { gm: 0.6, wm: 0.27, csf: 0.13 };
const OSPREY = {
  "3T TR 2000 TE 35": [22.2004079376, 18.9428915331, 3.86994117295, 12.874589505, 21.2504293053, 3.24725799436, 7.61951958838, 28.7750535636, 25.7583426324, 0.936887817661, 2.25236679181, 3.37855018771],
  "3T TR 3000/10000 TE 68/30": [30.1029065924, 28.64163175, 5.57125537752, 19.1815338371, 34.3435697447, 5.79833690249, 11.9456223737, 45.7746980429, 36.5358077418, 1.48877014562, 3.44954218747, 5.17431328121],
  "7T TR 2000 TE 35": [17.3312626595, 14.7743159304, 2.78418013957, 9.49787183449, 15.7656322709, 2.03777967428, 5.81928154537, 21.6701688159, 17.6736418725, 0.582028256165, 1.5797341307, 2.36960119605],
};
const rows = NAMES.map((name, k) => ({ name, concentration: CONC[k] }));

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs expected ${expected}`);
}

test("Gasparovic correction reproduces Osprey's quantTiss", () => {
  const cases = [
    ["3T TR 2000 TE 35", 3, { teMs: 35, trMs: 2000 }, { teMs: 35, trMs: 2000 }],
    ["3T TR 3000/10000 TE 68/30", 3, { teMs: 68, trMs: 3000 }, { teMs: 30, trMs: 10000 }],
    ["7T TR 2000 TE 35", 7, { teMs: 35, trMs: 2000 }, { teMs: 35, trMs: 2000 }],
  ];
  for (const [label, fieldT, metabolite, water] of cases) {
    const result = correctConcentrations(rows, { fractions: FRACTIONS, fieldT, metabolite, water });
    result.rows.forEach((r, k) => closeTo(r.corrected, OSPREY[label][k], `${label} ${r.name}`));
  }
});

test("alpha correction reproduces Osprey's quantAlpha for GABA and Glx", () => {
  // quantAlpha at 3 T, TR 2000 ms, TE 68 ms: GABA, Glu, Gln, Glx.
  const expected = { GABA: 3.06811822745, Glu: 17.9597896865, Gln: 6.2843931362, Glx: 24.0099542075 };
  const result = correctConcentrations(rows, { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 68, trMs: 2000 }, water: { teMs: 68, trMs: 2000 }, alpha: true });
  for (const [name, value] of Object.entries(expected)) closeTo(result.rows.find((r) => r.name === name).alphaCorrected, value, name);
  assert.equal(result.rows.find((r) => r.name === "NAA").alphaCorrected, undefined);
  // GABA+ under the co-edited MM model is alpha-corrected like Osprey's GABAplus.
  const plus = correctConcentrations([{ name: "GABA+MM3co", concentration: 2 }, { name: "GABAplus", concentration: 2 }], { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 68, trMs: 2000 }, water: { teMs: 68, trMs: 2000 }, alpha: true });
  assert.equal(plus.rows[0].alphaCorrected, plus.rows[1].alphaCorrected);
  assert.ok(plus.rows[0].alphaCorrected > 0);
});

test("LCModel's names map to Osprey's relaxation table", () => {
  assert.deepEqual(metaboliteRelaxation("Ins", 3), metaboliteRelaxation("mI", 3));
  assert.deepEqual(metaboliteRelaxation("NAA+NAAG", 3), metaboliteRelaxation("tNAA", 3));
  assert.deepEqual(metaboliteRelaxation("Cr+PCr", 7), metaboliteRelaxation("tCr", 7));
  assert.equal(metaboliteRelaxation("Scyllo", 7).t2, 0.105);
  assert.equal(metaboliteRelaxation("MM20", 3).known, false);
  // NAA at 3 T: T1 (1470 + 1350) / 2 ms, T2 ((253 + 263) / 2 + 343) / 2 ms.
  assert.equal(metaboliteRelaxation("NAA", 3).t1, 1.41);
  assert.equal(metaboliteRelaxation("NAA", 3).t2, 0.3005);
});

test("without metabolite relaxation the correction is the water term alone", () => {
  const base = { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 35, trMs: 2000 }, water: { teMs: 35, trMs: 2000 } };
  const on = correctConcentrations(rows, base).rows[0];
  const off = correctConcentrations(rows, { ...base, metaboliteRelaxation: false }).rows[0];
  const rm = (1 - Math.exp(-2 / on.t1)) * Math.exp(-0.035 / on.t2);
  closeTo(off.corrected, on.corrected * rm, "NAA");
});

test("pure white matter with no relaxation leaves LCModel's water scaling (bar its water content)", () => {
  // fWM = 1: c = ratio * 55510 * Rw_WM / (R_M = 1); LCModel used 35880 * 0.7.
  const r = correctConcentrations([{ name: "NAA", concentration: 10 }], {
    fractions: { gm: 0, wm: 1, csf: 0 },
    fieldT: 3,
    metabolite: { teMs: 35, trMs: 2000 },
    water: { teMs: 35, trMs: 2000 },
    metaboliteRelaxation: false,
  }).rows[0];
  const rw = (1 - Math.exp(-2 / 0.832)) * Math.exp(-0.035 / 0.0792);
  closeTo(r.corrected, 10 / (35880 * 0.7) * 55510 * rw, "NAA");
});

test("undoing LCModel water scaling is inverse in ATTH2O and proportional in ATTMET", () => {
  const options = {
    fractions: FRACTIONS,
    fieldT: 3,
    metabolite: { teMs: 68, trMs: 2000 },
    water: { teMs: 30, trMs: 10000 },
    alpha: true,
  };
  const input = [{ name: "GABA", concentration: 2 }];
  const baseline = correctConcentrations(input, options).rows[0];
  const cases = [
    [{ atth2o: 0.35 }, 2],
    [{ attmet: 0.5 }, 0.5],
    [{ wconc: 17940 }, 2],
    [{ atth2o: 0.35, attmet: 0.5 }, 1],
  ];
  for (const [lcmodel, factor] of cases) {
    const actual = correctConcentrations(input, { ...options, lcmodel }).rows[0];
    for (const key of ["corrected", "alphaCorrected"]) {
      closeTo(actual[key], baseline[key] * factor, `${key} with ${JSON.stringify(lcmodel)}`);
    }
  }
});

test("fractions are normalised and checked", () => {
  assert.deepEqual(normalizeFractions({ gm: 2, wm: 1, csf: 1 }), { gm: 0.5, wm: 0.25, csf: 0.25 });
  assert.throws(() => normalizeFractions({ gm: 0, wm: 0, csf: 1 }), /pure CSF/);
  assert.throws(() => normalizeFractions({ gm: -1, wm: 1, csf: 0 }), /0 to 1/);
  assert.equal(fieldKey(2.89), 3);
  assert.equal(fieldKey(1.5), null);
  assert.throws(() => correctConcentrations(rows, { fractions: FRACTIONS, fieldT: 1.5, metabolite: { teMs: 30, trMs: 2000 }, water: { teMs: 30, trMs: 2000 } }), /3 T and 7 T/);
});

test("the CSV holds both values, the fractions and the constants", () => {
  const result = correctConcentrations([{ name: "NAA+NAAG", concentration: 12, sdPercent: 3, ratio: 1.4 }], {
    fractions: FRACTIONS,
    fieldT: 3,
    metabolite: { teMs: 35, trMs: 2000 },
    water: { teMs: 35, trMs: 2000 },
  });
  const [header, line] = correctedCsv(result, "Cr+PCr").trim().split("\n");
  assert.match(header, /^Metabolite,LCModel \(mM\),SD \(%\),\/Cr\+PCr,Tissue-corrected \(mmol\/kg\),fGM,fWM,fCSF,/);
  const cells = line.split(",");
  assert.equal(cells[0], "NAA+NAAG");
  assert.equal(cells[1], "12");
  assert.equal(cells[4], "25.7583");
  assert.deepEqual(cells.slice(5, 8), ["0.6", "0.27", "0.13"]);
  assert.ok(header.includes("WCONC (mM)") && line.includes("35880"));
});

// Osprey's lookUpRelaxTimes (OspreyQuantify.m at 98b2e354), copied verbatim
// without its comments: [T1_GM T1_WM T2_GM T2_WM] in ms, and the averages it
// uses for a name not in the table.
const OSPREY_RELAXATION = {
  3: `
    relax.Asc   = [1340 1190 (125+105)/2 172];
    relax.Asp   = [1340 1190 (111+90)/2 148];
    relax.Cr    = [1460 1240 (148+144)/2 166];
    relax.GABA  = [1310 1310 (102+75)/2 (102+75)/2];
    relax.Glc   = [1340 1190 (117+88)/2 155];
    relax.Gln   = [1340 1190 (122+99)/2 168];
    relax.Glu   = [1270 1170 (135+122)/2 124];
    relax.Gly   = [1340 1190 (102+81)/2 152];
    relax.GPC   = [1300 1080 (274+222)/2 218];
    relax.GSH   = [1340 1190 (100+77)/2 145];
    relax.Lac   = [1340 1190 (110+99)/2 159];
    relax.mI   = [1230 1010 (244+229)/2 161];
    relax.NAA   = [1470 1350 (253+263)/2 343];
    relax.NAAG  = [1340 1190 (128+107)/2 185];
    relax.PCh   = [1300 1080 (274+221)/2 213];
    relax.PCr   = [1460 1240 (148+144)/2 166];
    relax.PE    = [1340 1190 (119+86)/2 158];
    relax.Scy   = [1340 1190 (125+107)/2 170];
    relax.Tau   = [1340 1190 (123+102)/2 (123+102)/2];
    relax.tNAA  = [(1470+1340)/2 (1350+1190)/2 (253+263+128+107)/4 (343+185)/2];
    relax.tCr  = [(1460+1460)/2 (1240+1240)/2 (148+144+148+144)/4 (166+166)/2];
    relax.tCho  = [(1300+1080)/2 (1080+1080)/2 (274+222+274+221)/4 (218+213)/2];
    relax.Glx  = [(1340+1270)/2 (1190+1170)/2 (122+99+135+122)/4 (168+124)/2];
    relax.default = [1340 1190 140 169];`,
  7: `
    relax.Asc   = [1530 1484 127 128];
    relax.Asp   = [1530 1484 127 128];
    relax.Cr    = [1740 1780 107 107];
    relax.GABA  = [1334 1334 87 87];
    relax.Glc   = [1530 1484 127 128];
    relax.Gln   = [1640 1740 107 107];
    relax.Glu   = [1610 1750 107 117];
    relax.Gly   = [1530 1484 127 128];
    relax.GPC   = [1510 1320  153 153];
    relax.GSH   = [1140 1060 79 79];
    relax.Lac   = [1530 1484 182 182];
    relax.mI   = [1280 1190 111 111];
    relax.NAA   = [1780 1830 155 155];
    relax.NAAG  = [1210 940 155 155];
    relax.PCh   = [1510 1320  153 153];
    relax.PCr   = [1740 1780 107 107];
    relax.PE    = [1310 1320 182 182];
    relax.sI   = [1310 1230 105 105];
    relax.Tau   = [2150 2090 97 97];
    relax.tNAA  = [1495 1385 155 155];
    relax.tCr  = [1740 1780 107 107];
    relax.tCho  = [1510 1320  153 153];
    relax.Glx  = [1625 1745 107 112];
    relax.default = [1530 1484 127 128];`,
};

/** Osprey's table as {name: [t1gm, t1wm, t2gm, t2wm]}, evaluating `(a+b+...)/n`. */
function ospreyTable(text) {
  const value = (cell) => {
    const mean = cell.match(/^\(([\d+]+)\)\/(\d+)$/);
    return mean ? mean[1].split("+").map(Number).reduce((a, b) => a + b) / Number(mean[2]) : Number(cell);
  };
  return Object.fromEntries([...text.matchAll(/relax\.(\w+)\s*=\s*\[([^\]]+)\]/g)].map(([, name, cells]) => [name, cells.trim().split(/\s+/).map(value)]));
}

test("every metabolite's relaxation times are Osprey's, averaged over GM and WM", () => {
  for (const field of [3, 7]) {
    const table = ospreyTable(OSPREY_RELAXATION[field]);
    assert.equal(Object.keys(table).length, 24);
    for (const [name, [t1gm, t1wm, t2gm, t2wm]] of Object.entries(table)) {
      const looked = metaboliteRelaxation(name, field);
      closeTo(looked.t1, (t1gm + t1wm) / 2 / 1000, `${field} T ${name} T1`);
      closeTo(looked.t2, (t2gm + t2wm) / 2 / 1000, `${field} T ${name} T2`);
      assert.equal(looked.known, name !== "default", `${field} T ${name}`);
    }
    // A basis name Osprey does not list takes the averages, and says so.
    assert.deepEqual(metaboliteRelaxation("Lip13", field), { ...metaboliteRelaxation("default", field), known: false });
  }
});

test("LCModel's combined names and Scyllo take Osprey's entries", () => {
  for (const field of [3, 7]) {
    for (const [lcmodel, osprey] of [["GPC+PCh", "tCho"], ["PCh+GPC", "tCho"], ["Glu+Gln", "Glx"], ["Ins", "mI"]]) {
      assert.deepEqual(metaboliteRelaxation(lcmodel, field), metaboliteRelaxation(osprey, field), `${field} T ${lcmodel}`);
    }
  }
  assert.deepEqual(metaboliteRelaxation("Scyllo", 3), metaboliteRelaxation("Scy", 3));
  assert.deepEqual(metaboliteRelaxation("Scyllo", 7), metaboliteRelaxation("sI", 7));
  assert.equal(metaboliteRelaxation("Scyllo", 3).known, true);
});

test("relaxation tables apply from 2.8 to 3.1 T and from 6.5 to 7.5 T only", () => {
  for (const [fieldT, key] of [[2.79, null], [2.8, 3], [3.0, 3], [3.0999, 3], [3.1, null], [6.49, null], [6.5, 7], [6.98, 7], [7.4999, 7], [7.5, null], [9.4, null]]) {
    assert.equal(fieldKey(fieldT), key, `${fieldT} T`);
  }
});

const BASE = { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 35, trMs: 2000 }, water: { teMs: 35, trMs: 2000 } };

test("fractions that add up to zero and missing timing are refused", () => {
  assert.throws(() => normalizeFractions({ gm: 0, wm: 0, csf: 0 }), /add up to zero/);
  const timings = [
    [{ teMs: 0, trMs: 2000 }, BASE.water],
    [{ teMs: 35, trMs: 0 }, BASE.water],
    [BASE.metabolite, { teMs: 0, trMs: 2000 }],
    [BASE.metabolite, { teMs: 35 }],
  ];
  for (const [metabolite, water] of timings) {
    assert.throws(() => correctConcentrations(rows, { ...BASE, metabolite, water }), /needs the echo and repetition times of both scans/);
  }
});

test("alpha correction covers GABA, GABA+ and glutamate signals under every name, and nothing else", () => {
  const names = ["GABA", "Glu", "Gln", "Glx", "Glu+Gln", "GABA+", "GABAplus", "GABA+MM3co", "NAA", "Cr+PCr", "MM3co"];
  const result = correctConcentrations(names.map((name) => ({ name, concentration: 2 })), { ...BASE, alpha: true });
  for (const row of result.rows) assert.equal(row.alphaCorrected != null, !["NAA", "Cr+PCr", "MM3co"].includes(row.name), row.name);
  assert.equal(result.constants.alpha, 0.5);
  assert.equal(correctConcentrations(rows, BASE).constants.alpha, null);
});

test("the result records the method, unit and both scans' timing", () => {
  const result = correctConcentrations(rows, { ...BASE, metabolite: { teMs: 68, trMs: 3000 }, water: { teMs: 30, trMs: 10000 } });
  assert.equal(result.field, 3);
  assert.equal(result.constants.method, "Gasparovic et al. 2006 (Osprey quantTiss)");
  assert.equal(result.constants.unit, "mmol/kg tissue water");
  assert.deepEqual(result.constants.metabolite, { teMs: 68, trMs: 3000 });
  assert.deepEqual(result.constants.water, { teMs: 30, trMs: 10000 });
  assert.equal(result.constants.metaboliteRelaxation, true);
  assert.deepEqual(result.constants.lcmodel, { wconc: 35880, atth2o: 0.7, attmet: 1 });
});

const HEADER = [
  "Metabolite",
  "LCModel (mM)",
  "SD (%)",
  "Ratio",
  "Tissue-corrected (mmol/kg)",
  "Alpha-corrected (mmol/kg)",
  "fGM",
  "fWM",
  "fCSF",
  "Metabolite T1 (ms)",
  "Metabolite T2 (ms)",
  "Metabolite relaxation corrected",
  "TE (ms)",
  "TR (ms)",
  "Water TE (ms)",
  "Water TR (ms)",
  "WCONC (mM)",
  "ATTH2O",
  "Method",
].join(",");

test("the CSV has every column, leaves missing values empty and quotes names", () => {
  const input = [
    { name: "GABA+MM3co", concentration: 2, sdPercent: 7, ratio: 0.3 },
    { name: "NAA", concentration: 10 },
    { name: 'Lip "13", MM', concentration: Number.NaN },
  ];
  const options = { ...BASE, metabolite: { teMs: 68, trMs: 2000 }, water: { teMs: 30, trMs: 10000 }, alpha: true, metaboliteRelaxation: false };
  const result = correctConcentrations(input, options);
  const csv = correctedCsv(result, null);
  assert.ok(csv.endsWith("\n") && !csv.endsWith("\n\n"));
  const [header, gaba, naa, lip] = csv.slice(0, -1).split("\n");
  assert.equal(header, HEADER);
  const g = gaba.split(",");
  assert.deepEqual(g.slice(0, 4), ["GABA+MM3co", "2", "7", "0.3"]);
  assert.equal(Number(g[4]), Number(result.rows[0].corrected.toPrecision(6)));
  assert.equal(Number(g[5]), Number(result.rows[0].alphaCorrected.toPrecision(6)));
  const constants = ["0.6", "0.27", "0.13", "1265", "155", "no", "68", "2000", "30", "10000", "35880", "0.7", "Gasparovic et al. 2006 (Osprey quantTiss)"];
  assert.deepEqual(g.slice(6), constants);
  const n = naa.split(",");
  assert.deepEqual(n.slice(0, 6), ["NAA", "10", "", "", n[4], ""]);
  assert.ok(Number(n[4]) > 0);
  assert.deepEqual(n.slice(9, 11), ["1410", "301"]);
  assert.ok(lip.startsWith('"Lip ""13"", MM",NaN,,,,,'), lip);
  // Without metabolites to alpha-correct there is no alpha column, and relaxation says yes.
  const plain = correctedCsv(correctConcentrations([{ name: "NAA", concentration: 10 }], BASE), "Cr+PCr").split("\n");
  assert.equal(plain[0], HEADER.replace("Ratio", "/Cr+PCr").replace("Alpha-corrected (mmol/kg),", ""));
  assert.equal(plain[1].split(",")[10], "yes");
});

test("a fit is corrected only with fractions, a water reference and a supported header", () => {
  const header = { fieldT: 2.89, teMs: 68, trMs: 3000, waterTeMs: 30, waterTrMs: 10000 };
  const options = { fractions: FRACTIONS, header, waterScaled: true, edited: false, metaboliteRelaxation: true };
  assert.equal(correctionFor(rows, { ...options, fractions: null }), null);
  assert.deepEqual(correctionFor(rows, { ...options, waterScaled: false }), { reason: "Tissue correction needs water-scaled concentrations (a water reference)." });
  assert.deepEqual(correctionFor(rows, { ...options, header: null }), { reason: "Tissue correction needs the acquisition header (not a .RAW file)." });
  assert.deepEqual(correctionFor(rows, { ...options, header: { ...header, fieldT: 1.494 } }), { reason: "Relaxation constants are tabulated for 3 T and 7 T, not 1.49 T." });
  assert.deepEqual(correctionFor(rows, { ...options, fractions: { gm: 0, wm: 0, csf: 1 } }), { reason: "A voxel of pure CSF has no tissue to correct to." });
  const explicit = { fractions: FRACTIONS, fieldT: 2.89, metabolite: { teMs: 68, trMs: 3000 }, water: { teMs: 30, trMs: 10000 } };
  assert.deepEqual(correctionFor(rows, options), correctConcentrations(rows, { ...explicit, metaboliteRelaxation: true, alpha: false }));
  const edited = correctionFor(rows, { ...options, edited: true, metaboliteRelaxation: false });
  assert.deepEqual(edited, correctConcentrations(rows, { ...explicit, metaboliteRelaxation: false, alpha: true, lcmodel: { atth2o: 0.43 } }));
  // Without its own water timing the water scan is taken to match the metabolite scan.
  const { fieldT, teMs, trMs } = header;
  const sameWater = correctConcentrations(rows, { ...explicit, water: explicit.metabolite, metaboliteRelaxation: true, alpha: false });
  assert.deepEqual(correctionFor(rows, { ...options, header: { fieldT, teMs, trMs } }), sameWater);
});

test("MEGA-PRESS tissue and alpha correction undo the fitted 0.43 water attenuation", () => {
  // The shared pipeline fits edited data with sptype='mega-press-3'.
  // Native LCModel's preset uses ATTH2O = 0.43 (control.rs), not 0.7.
  // Osprey quantTiss/quantAlpha, rerun with amplWater = 35880 * 0.43.
  const result = correctionFor([{ name: "GABA", concentration: 1.2 }], {
    fractions: FRACTIONS,
    header: { fieldT: 3, teMs: 68, trMs: 2000 },
    waterScaled: true,
    edited: true,
    metaboliteRelaxation: true,
  });
  assert.equal(result.constants.lcmodel.atth2o, 0.43);
  closeTo(result.rows[0].corrected, 5.70465439344, "MEGA-PRESS GABA");
  closeTo(result.rows[0].alphaCorrected, 4.99461106795, "MEGA-PRESS alpha GABA");
});

test("the downloads are the corrected table and every input behind it", () => {
  const result = correctConcentrations([{ name: "GABA", concentration: 2 }, { name: "NAA", concentration: 10 }], { ...BASE, alpha: true });
  const texts = tissueTexts(result, "sub-01_PRESS", "Cr+PCr");
  assert.deepEqual(Object.keys(texts), ["tissueConcentrations", "tissueReport"]);
  const { body: csv, ...table } = texts.tissueConcentrations;
  assert.deepEqual(table, { description: "Tissue-corrected concentrations (.csv)", name: "sub-01_PRESS_tissue_corrected.csv", type: "text/csv", viewable: false });
  assert.equal(csv, correctedCsv(result, "Cr+PCr"));
  const { body, ...report } = texts.tissueReport;
  assert.deepEqual(report, { description: "Tissue correction inputs (.json)", name: "sub-01_PRESS_tissue_correction.json", type: "application/json", viewable: false });
  const json = JSON.parse(body);
  assert.deepEqual([json.fractionSource, json.voxel, json.voxelInT1Mm3], ["entered", null, null]);
  assert.deepEqual(json.fractions, result.fractions);
  assert.deepEqual(json.molalFractions, result.molalFractions);
  assert.deepEqual(json.waterAttenuation, result.waterAttenuation);
  assert.equal(json.method, result.constants.method);
  assert.deepEqual(json.metabolite, BASE.metabolite);
  const [gaba, naa] = json.concentrations;
  assert.deepEqual(Object.keys(gaba), ["name", "lcmodel", "corrected", "alphaCorrected", "t1Ms", "t2Ms"]);
  assert.equal(gaba.alphaCorrected, result.rows[0].alphaCorrected);
  assert.equal(naa.alphaCorrected, null);
  assert.deepEqual([naa.name, naa.lcmodel, naa.corrected], ["NAA", 10, result.rows[1].corrected]);
  closeTo(naa.t1Ms, 1410, "NAA T1");
  closeTo(naa.t2Ms, 300.5, "NAA T2");
  const voxel = { centre: [1, 2, 3] };
  const segmented = JSON.parse(tissueTexts(result, "x", null, { fractionSource: "MindMap", voxel, voxelInT1Mm3: 8000 }).tissueReport.body);
  assert.deepEqual([segmented.fractionSource, segmented.voxel, segmented.voxelInT1Mm3], ["MindMap", voxel, 8000]);
});

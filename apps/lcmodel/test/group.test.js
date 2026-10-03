import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCoord } from "../src/lcmodel-io.js";
import { STATUS, QC_COLUMNS, groupRecord, groupCsvLong, groupCsvWide, metaboliteNames, planBases, preprocessingQc, uniqueNames, fileStem } from "../src/group.js";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);

// FID-A's report for a PRESS run, trimmed to what the group table reads.
const fidaReport = {
  pipeline: "run_pressproc_auto",
  rm_bad_averages: { nsd: 4, averages_before: 64, averages_after: 61 },
  drift: { total_freq_drift: 1.25 },
  snr: 88.4,
  linewidth_naa: 6.2,
};

function parseCsv(text) {
  // Enough CSV for these tests: quoted cells may hold commas and doubled quotes.
  return text.trimEnd().split("\n").map((line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
    .slice(0, -1)
    .map(([, cell]) => (cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell)));
}

async function fittedRecord(name, scale = 1) {
  const coord = parseCoord(await readFile(new URL("native.coord", native), "utf8"));
  return groupRecord({
    name,
    file: `study/${name}/metab.RAW`,
    format: "Philips SDAT/SPAR",
    status: STATUS.fitted,
    basis: "press-3t-te35",
    unit: "mM",
    ratioTo: coord.ratioTo,
    preprocessing: fidaReport,
    summary: coord.summary,
    metabolites: coord.rows.map((r) => ({ ...r, concentration: r.concentration * scale })),
  });
}

test("FID-A quality numbers come from the full pipelines and the coil-combined path", () => {
  assert.deepEqual(preprocessingQc(fidaReport), { averages: 64, averagesRemoved: 3, driftHz: 1.25, fidaSnr: 88.4, fidaLinewidthHz: 6.2 });
  const combined = preprocessingQc({ pipeline: "combined", averagesRaw: 1, snr: 40, linewidthHz: 7.5, drift: null });
  assert.deepEqual(combined, { averages: 1, averagesRemoved: null, driftHz: null, fidaSnr: 40, fidaLinewidthHz: 7.5 });
  assert.equal(preprocessingQc(null).fidaSnr, null);
});

test("the long CSV has one row per dataset and metabolite and keeps failed datasets", async () => {
  const records = [
    await fittedRecord("sub-01"),
    groupRecord({ name: "sub-02, retest", file: "study/sub-02/metab.RAW", status: STATUS.failed, error: 'LCModel stopped ("MYBASI 9").' }),
    await fittedRecord("sub-03", 2),
  ];
  const rows = parseCsv(groupCsvLong(records));
  const header = rows[0];
  assert.deepEqual(header.slice(0, 9), ["dataset", "file", "status", "error", "format", "basis", "edited", "unit", "ratio_to"]);
  assert.deepEqual(header.slice(-4), ["metabolite", "concentration", "sd_percent", "ratio"]);
  assert.equal(header.length, 9 + QC_COLUMNS.length + 4);
  assert.equal(rows.length, 1 + 35 + 1 + 35);
  const col = (name) => header.indexOf(name);
  const naa = rows.find((r) => r[col("dataset")] === "sub-01" && r[col("metabolite")] === "NAA");
  assert.deepEqual([naa[col("concentration")], naa[col("sd_percent")], naa[col("ratio")]], ["0.00000191", "5", "1.047"]);
  assert.equal(naa[col("unit")], "mM");
  assert.equal(naa[col("ratio_to")], "Cr+PCr");
  assert.equal(naa[col("averages_removed")], "3");
  assert.equal(naa[col("lcmodel_fwhm_ppm")], "0.084");
  const failed = rows.filter((r) => r[col("dataset")] === "sub-02, retest");
  assert.equal(failed.length, 1);
  assert.equal(failed[0][col("status")], "failed");
  assert.equal(failed[0][col("error")], 'LCModel stopped ("MYBASI 9").');
  assert.equal(failed[0][col("metabolite")], "");
  assert.equal(rows.find((r) => r[col("dataset")] === "sub-03" && r[col("metabolite")] === "NAA")[col("concentration")], "0.00000382");
});

test("the wide CSV has one row per dataset and three columns per metabolite", async () => {
  const mega = groupRecord({
    name: "mega",
    status: STATUS.fitted,
    unit: "a.u.",
    ratioTo: "NAA+NAAG",
    edited: true,
    metabolites: [{ name: "GABA", concentration: 0.3, sdPercent: 12, ratio: 0.21 }, { name: "NAA", concentration: 1.4, sdPercent: 2, ratio: 0.97 }],
  });
  const records = [await fittedRecord("sub-01"), mega];
  const names = metaboliteNames(records);
  assert.equal(names[0], "Ala");
  assert.ok(names.includes("GABA"));
  assert.equal(new Set(names).size, names.length, "each metabolite once");
  const rows = parseCsv(groupCsvWide(records));
  assert.equal(rows.length, 3);
  const header = rows[0];
  assert.equal(header.length, 9 + QC_COLUMNS.length + 3 * names.length);
  const col = (name) => header.indexOf(name);
  assert.equal(rows[1][col("NAA")], "0.00000191");
  assert.equal(rows[1][col("NAA_sd_percent")], "5");
  assert.equal(rows[1][col("NAA_ratio")], "1.047");
  assert.equal(rows[2][col("NAA_ratio")], "0.97");
  assert.equal(rows[2][col("ratio_to")], "NAA+NAAG", "ratio reference per row, not per column");
  assert.equal(rows[2][col("edited")], "true");
  assert.equal(rows[2][col("Ala")], "", "metabolites missing from a basis are empty");
});

test("a group shares the user's basis set only when it fits every dataset", () => {
  const datasets = [
    { recommended: "press-3t-te35", choiceUsable: true },
    { recommended: "megapress-3t-te68-diff", choiceUsable: false },
  ];
  // Left at the recommendation: each dataset gets its own.
  assert.deepEqual(planBases({ choice: "press-3t-te35", custom: false, selectedRecommendation: "press-3t-te35", datasets }),
    { mode: "recommended", bases: ["press-3t-te35", "megapress-3t-te68-diff"], overridden: false });
  // Picked by the user and usable for all: everyone shares it.
  const same = datasets.map((d) => ({ ...d, choiceUsable: true }));
  assert.deepEqual(planBases({ choice: "press-3t-te30", custom: false, selectedRecommendation: "press-3t-te35", datasets: same }),
    { mode: "chosen", bases: ["press-3t-te30", "press-3t-te30"], overridden: false });
  // Picked but unusable for one: recommendations, and say so.
  assert.deepEqual(planBases({ choice: "press-3t-te30", custom: false, selectedRecommendation: "press-3t-te35", datasets }),
    { mode: "recommended", bases: ["press-3t-te35", "megapress-3t-te68-diff"], overridden: true });
  // A dropped .BASIS file is explicit and fits everyone.
  assert.deepEqual(planBases({ choice: "custom", custom: true, selectedRecommendation: "press-3t-te35", datasets }).bases, ["custom", "custom"]);
  // No usable library set for a dataset: null, which the run reports as a failure.
  assert.deepEqual(planBases({ choice: "a", custom: false, selectedRecommendation: "a", datasets: [{ recommended: null, choiceUsable: false }] }).bases, [null]);
});

test("display names add folders only where stems clash", () => {
  assert.deepEqual(uniqueNames([{ name: "sub-01_act", path: "a/sub-01_act.sdat" }, { name: "sub-02_act", path: "b/sub-02_act.sdat" }]), ["sub-01_act", "sub-02_act"]);
  assert.deepEqual(uniqueNames([
    { name: "metab", path: "study/sub-01/ses-1/metab.RAW" },
    { name: "metab", path: "study/sub-02/ses-1/metab.RAW" },
    { name: "other", path: "study/other.RAW" },
  ]), ["sub-01/ses-1/metab", "sub-02/ses-1/metab", "other"]);
  assert.deepEqual(uniqueNames([{ name: "svs", path: "sub-01/svs.rda" }, { name: "svs", path: "sub-02/svs.rda" }]), ["sub-01/svs", "sub-02/svs"]);
  assert.deepEqual(uniqueNames([{ name: "x", path: "x.rda" }, { name: "x", path: null }]), ["x (1)", "x (2)"]);
  assert.equal(fileStem("sub-01/ses 1/metab"), "sub-01_ses_1_metab");
  assert.equal(fileStem("P17920.7"), "P17920");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { buildControl, parseCoord, fillGaps, parseTable, concentrationsCsv, presentRows, FILES, LINE_BROADENING, coordGaps, summarizeMisc, lcmodelError, explainDiagnostic } from "../src/lcmodel-io.js";
import { spectrumSvg, fitSeries, metaboliteSeries, visibleIndices, tickStep, splitAtGaps } from "../src/spectrum-plot.js";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);

// The Siemens MEGA-PRESS example fitted as the app fits it (co-edited MM
// model, PPMGAP 1.95-1.2 ppm): the .RAW LCModel read and the .COORD it wrote.
const mega = async (ext) => gunzipSync(await readFile(new URL(`data/siemens-megapress.${ext}.gz`, import.meta.url))).toString("utf8");
const MEGA_ACQUISITION = { deltat: 4.167e-4, hzpppm: 123.247115 };

/** `raw` with its spectrum moved by `ppm` (the FID times a complex exponential). */
function shiftRaw(raw, ppm, { deltat, hzpppm }) {
  const end = raw.lastIndexOf("$END") + 4;
  const numbers = raw.slice(end).trim().split(/\s+/).map(Number);
  const lines = [];
  for (let k = 0; k < numbers.length; k += 2) {
    const w = 2 * Math.PI * ppm * hzpppm * (k / 2) * deltat;
    const [re, im] = [numbers[k], numbers[k + 1]];
    lines.push(`${(re * Math.cos(w) - im * Math.sin(w)).toExponential(6)} ${(re * Math.sin(w) + im * Math.cos(w)).toExponential(6)}`);
  }
  return `${raw.slice(0, end)}\n${lines.join("\n")}\n`;
}

test("control file names the inputs and enables water scaling only with water", () => {
  const plain = buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, teMs: 30 });
  assert.match(plain, /^ \$LCMODL\n/);
  assert.match(plain, /nunfil=2048\n/);
  assert.match(plain, new RegExp(`filraw='${FILES.raw}'`));
  assert.match(plain, /lps=0/);
  assert.doesNotMatch(plain, /dows/);
  assert.match(plain, / \$END\n$/);
  const water = buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, water: true, title: "Mary's scan" });
  assert.match(water, /dows=T/);
  assert.match(water, /doecc=T/);
  assert.match(water, /title='Mary''s scan'/);
  assert.match(buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123, water: true, ecc: false }), /doecc=F/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: Number.NaN, hzpppm: 123 }), /finite/);
  const mega = buildControl({ nunfil: 2080, deltat: 4.167e-4, hzpppm: 123.247, sptype: "mega-press-3", ppmStart: 4.2, ppmEnd: 1.95 });
  assert.match(mega, /\n sptype='mega-press-3'\n/);
  assert.match(mega, /ppmend=1\.95/);
  assert.doesNotMatch(plain, /sptype/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: 2e-4, hzpppm: 123, ppmStart: 0.2, ppmEnd: 4 }), /fit range/);
});

test("the line-broadening prior is widened by default and LCModel's own on request", () => {
  const options = { nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, water: true };
  const widened = buildControl(options);
  assert.match(widened, /\n desdt2=2\n rfwbas=80\n/);
  assert.equal(buildControl({ ...options, lineBroadening: "widened" }), widened);
  const lcmodel = buildControl({ ...options, lineBroadening: "lcmodel" });
  assert.doesNotMatch(lcmodel, /desdt2|rfwbas/);
  assert.equal(lcmodel, widened.replace(" desdt2=2\n rfwbas=80\n", ""), "nothing else changes");
  assert.deepEqual(Object.keys(LINE_BROADENING), ["widened", "lcmodel"]);
  assert.throws(() => buildControl({ ...options, lineBroadening: "wide" }), /line-broadening/);
});

test("a MEGA-PRESS fit can separate GABA from co-edited MM3co", () => {
  const options = { nunfil: 2080, deltat: 4.167e-4, hzpppm: 123.247, sptype: "mega-press-3", ppmStart: 4.2, ppmEnd: 0.5 };
  const mm = buildControl({ ...options, coEditedMM: true });
  assert.match(mm, /\n nsimul=2\n/);
  assert.match(mm, /chsimu\(1\)='MM09 @ \.915 /);
  // 14 Hz at 123.247 MHz is 0.114 ppm; the minimum Gaussian width is 10.5 Hz.
  assert.match(mm, /chsimu\(2\)='MM3co @ 3\.0 \+- \.02 FWHM= 0\.085 < 0\.114 \+- \.02 AMP= 2\.'/);
  assert.match(mm, /chrato\(2\)='MM3co\/MM09 = 1\. \+- \.2'/);
  assert.match(mm, /\n ncombi=18\n chcomb\(18\)='GABA\+MM3co'\n/);
  // Osprey's GAP.diff1: the region the editing pulse hits directly is not fitted.
  assert.match(mm, /\n ppmgap\(1,1\)=1\.95\n ppmgap\(2,1\)=1\.2\n/);
  // Without the model: LCModel's mega-press-3 as before (its own MM09, no MM3co).
  const old = buildControl({ ...options, ppmEnd: 1.95, coEditedMM: false });
  assert.doesNotMatch(old, /MM3co|nsimul|chsimu|chrato|ncombi|ppmgap/);
  assert.match(old, /ppmend=1\.95/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: 2e-4, hzpppm: 123, coEditedMM: true }), /MEGA-PRESS/);
});

test("results lead with GABA+ and mark GABA and MM3co as model-dependent", () => {
  const rows = [
    { name: "GABA", concentration: 1.3e-5, sdPercent: 12, ratio: 0.131, combination: false },
    { name: "NAA", concentration: 8e-5, sdPercent: 1, ratio: 0.925, combination: false },
    { name: "MM3co", concentration: 1.5e-5, sdPercent: 12, ratio: 0.165, combination: false },
    { name: "NAA+NAAG", concentration: 8.8e-5, sdPercent: 1, ratio: 1, combination: true },
    { name: "GABA+MM3co", concentration: 2.6e-5, sdPercent: 6, ratio: 0.296, combination: true },
  ];
  const shown = presentRows(rows);
  assert.deepEqual(shown.map((r) => r.name), ["GABA+MM3co", "GABA", "MM3co", "NAA", "NAA+NAAG"]);
  assert.equal(shown[0].primary, true);
  assert.deepEqual(shown.map((r) => Boolean(r.modelDependent)), [false, true, true, false, false]);
  const csv = concentrationsCsv(shown, "NAA+NAAG").split("\n");
  assert.equal(csv[0], "Metabolite,Concentration,SD (%),/NAA+NAAG,Note");
  assert.match(csv[1], /^GABA\+MM3co,.*,GABA\+ \(GABA \+ MM3co\): primary result$/);
  assert.match(csv[2], /^GABA,.*,model-dependent: /);
  assert.match(csv[4], /^NAA,0\.00008,1,0\.925,$/);
  // Fits without the model keep LCModel's order and the four-column CSV.
  const plain = rows.filter((r) => !r.name.includes("MM3co"));
  assert.deepEqual(presentRows(plain), plain);
  assert.doesNotMatch(concentrationsCsv(plain, "NAA+NAAG"), /Note/);
});

test("parses LCModel's own .COORD and .TABLE output", async () => {
  const coord = parseCoord(await readFile(new URL("native.coord", native), "utf8"));
  assert.equal(coord.ratioTo, "Cr+PCr");
  assert.equal(coord.rows.length, 35);
  const naa = coord.rows.find((r) => r.name === "NAA");
  assert.deepEqual([naa.concentration, naa.sdPercent, naa.ratio], [1.91e-6, 5, 1.047]);
  assert.equal(coord.rows.find((r) => r.name === "PCh").sdPercent, 999);
  assert.equal(coord.ppm.length, 498);
  assert.equal(coord.data.length, 498);
  assert.equal(coord.fit.length, 498);
  assert.equal(coord.background.length, 498);
  assert.ok(coord.ppm[0] > coord.ppm[497]);
  assert.deepEqual(coord.summary, { fwhmPpm: 0.084, snr: 21, shiftPpm: 0.008, phase0Deg: 9, phase1DegPerPpm: 2.2 });
  const table = parseTable(await readFile(new URL("native.table", native), "utf8"));
  assert.deepEqual(table.rows, coord.rows);
  const csv = concentrationsCsv(table.rows, table.ratioTo);
  assert.match(csv.split("\n")[0], /^Metabolite,Concentration,SD \(%\),\/Cr\+PCr$/);
  assert.match(csv, /\nNAA,0\.00000191,5,1\.047\n/);
});

test("spectrum plot scales ppm right to left and escapes labels", async () => {
  const coord = parseCoord(await readFile(new URL("native.coord", native), "utf8"));
  const svg = spectrumSvg({ ppm: coord.ppm, series: fitSeries(coord), range: [4.2, 0.2], ariaLabel: "LCModel fit <test>" });
  assert.match(svg, /^<svg class="lcm-plot"/);
  assert.match(svg, /aria-label="LCModel fit &lt;test&gt;"/);
  assert.equal((svg.match(/<polyline/g) || []).length, 4);
  const firstX = Number(svg.match(/class="lcm-data" points="([\d.]+),/)[1]);
  assert.ok(firstX < 100, "highest ppm drawn at the left");
  const stack = metaboliteSeries({ ...coord, metabolites: [{ name: "NAA", curve: coord.fit }, { name: "<b>", curve: coord.background }] });
  assert.equal(stack.length, 1, "curves equal to the baseline are dropped");
  assert.equal(tickStep(4, 8), 0.5);
  const idx = visibleIndices([5, 4, 3, 2, 1, 0], [0, 0, 0, 0, 0, 0], 1, 4);
  assert.deepEqual(idx, [1, 2, 3, 4]);
  // A PPMGAP window is missing from the .COORD axis; no line crosses it.
  const gapped = [2.2, 2.1, 2.0, 1.9, 1.1, 1.0, 0.9];
  assert.deepEqual(splitAtGaps(gapped, [0, 1, 2, 3, 4, 5, 6]), [[0, 1, 2, 3], [4, 5, 6]]);
  const gapSvg = spectrumSvg({ ppm: gapped, series: [{ values: [0, 1, 0, 1, 0, 1, 0], kind: "data", label: "d" }], range: [2.2, 0.9], ariaLabel: "gap" });
  assert.equal((gapSvg.match(/<polyline/g) || []).length, 2);
});

test("the window left out of a MEGA-PRESS fit is rebuilt from the .RAW file", async () => {
  const coord = parseCoord(await mega("coord"));
  const raw = await mega("raw");
  assert.equal(coord.gaps.length, 1);
  assert.ok(Math.abs(coord.gaps[0].hi - 1.95) < 0.01 && Math.abs(coord.gaps[0].lo - 1.2) < 0.01, JSON.stringify(coord.gaps));
  const [gap] = fillGaps(coord, raw, MEGA_ACQUISITION);
  assert.equal(gap.ppm.length, 160, "the .COORD spacing across 1.95-1.2 ppm");
  assert.ok(gap.ppm.every((p) => p < gap.hi && p > gap.lo));
  // Over the fitted points it reproduces LCModel's data to 2.5 %; a wrong
  // first-order phase sign takes that past 4 %.
  assert.ok(fillGaps(coord, raw, MEGA_ACQUISITION, { tolerance: 0.03 })[0].data);

  // Hide 2.5-2.2 ppm (Glx, NAA's shoulder) as if it were excluded too: the
  // rebuilt spectrum there must be LCModel's own phased data.
  const hidden = coord.ppm.map((p, k) => (p < 2.5 && p > 2.2 ? k : -1)).filter((k) => k >= 0);
  const keep = (values) => values.filter((_, k) => !hidden.includes(k));
  const window = { hi: coord.ppm[hidden[0] - 1], lo: coord.ppm[hidden.at(-1) + 1] };
  const [rebuilt] = fillGaps({ ...coord, ppm: keep(coord.ppm), data: keep(coord.data), gaps: [window] }, raw, MEGA_ACQUISITION);
  assert.equal(rebuilt.ppm.length, hidden.length);
  const truth = hidden.map((k) => coord.data[k]);
  const miss = Math.sqrt(truth.reduce((sum, d, i) => sum + (rebuilt.data[i] - d) ** 2, 0) / truth.reduce((sum, d) => sum + d * d, 0));
  assert.ok(miss < 0.05, `rebuilt 2.5-2.2 ppm misses LCModel's data by ${(miss * 100).toFixed(1)} %`);

  // LCModel references a shifted spectrum back; the rebuild follows its shift.
  const shifted = shiftRaw(raw, 0.03, MEGA_ACQUISITION);
  const summary = { ...coord.summary, shiftPpm: 0.03 };
  assert.ok(fillGaps({ ...coord, summary }, shifted, MEGA_ACQUISITION)[0].data, "shift applied");
  // A rebuild that does not line up is not drawn.
  assert.equal(fillGaps(coord, shifted, MEGA_ACQUISITION)[0].data, undefined);
});

test("a MEGA-PRESS fit plot shades the excluded window and draws the data through it", async () => {
  const coord = parseCoord(await mega("coord"));
  const filled = { ...coord, gaps: fillGaps(coord, await mega("raw"), MEGA_ACQUISITION) };
  const svg = spectrumSvg({ ppm: coord.ppm, series: fitSeries(filled), range: [4.4, 0.3], gaps: filled.gaps, ariaLabel: "MEGA" });
  assert.equal((svg.match(/<rect class="lcm-gap"/g) || []).length, 1);
  assert.match(svg, />not fitted</);
  const lines = (kind) => (svg.match(new RegExp(`class="lcm-${kind}"`, "g")) || []).length;
  assert.equal(lines("data"), 1, "data runs through the window");
  assert.equal(lines("fit"), 2, "the fit stops at it");
  assert.equal(lines("residual"), 2);
  // Without the rebuilt data the window is still shaded, and nothing crosses it.
  const bare = spectrumSvg({ ppm: coord.ppm, series: fitSeries(coord), range: [4.4, 0.3], gaps: coord.gaps, ariaLabel: "MEGA" });
  assert.equal((bare.match(/<rect class="lcm-gap"/g) || []).length, 1);
  assert.equal((bare.match(/class="lcm-data"/g) || []).length, 2);
});

test("the control file is exactly the namelist LCModel reads", () => {
  const press = buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, teMs: 30, water: true, title: "PRESS 30" });
  assert.equal(press, [
    " $LCMODL",
    " key=210387309",
    " lps=0",
    " nunfil=2048",
    " deltat=0.00025",
    " hzpppm=123.247",
    " filbas='basis.basis'",
    " filraw='spectrum.raw'",
    " ppmst=4",
    " ppmend=0.2",
    " lcoord=9",
    " filcoo='result.coord'",
    " ltable=7",
    " filtab='result.table'",
    " lcsv=11",
    " filcsv='result.csv'",
    " neach=99",
    " desdt2=2",
    " rfwbas=80",
    " echot=30",
    " filh2o='water.h2o'",
    " dows=T",
    " doecc=T",
    " title='PRESS 30'",
    " $END",
    "",
  ].join("\n"));
  assert.deepEqual(FILES, { raw: "spectrum.raw", h2o: "water.h2o", basis: "basis.basis", table: "result.table", coord: "result.coord", csv: "result.csv" });
  const mega = buildControl({ nunfil: 2080, deltat: 4.167e-4, hzpppm: 123.247, teMs: 68, sptype: "mega-press-3", ppmStart: 4.2, ppmEnd: 0.5, coEditedMM: true, lineBroadening: "lcmodel" });
  assert.equal(mega, [
    " $LCMODL",
    " key=210387309",
    " lps=0",
    " sptype='mega-press-3'",
    " nunfil=2080",
    " deltat=0.0004167",
    " hzpppm=123.247",
    " filbas='basis.basis'",
    " filraw='spectrum.raw'",
    " ppmst=4.2",
    " ppmend=0.5",
    " lcoord=9",
    " filcoo='result.coord'",
    " ltable=7",
    " filtab='result.table'",
    " lcsv=11",
    " filcsv='result.csv'",
    " neach=99",
    " nsimul=2",
    " chsimu(1)='MM09 @ .915 +- .02 FWHM= .085 < .1 +- .35 AMP= 3.'",
    " chsimu(2)='MM3co @ 3.0 +- .02 FWHM= 0.085 < 0.114 +- .02 AMP= 2.'",
    " nratio=2",
    " chrato(2)='MM3co/MM09 = 1. +- .2'",
    " ncombi=18",
    " chcomb(18)='GABA+MM3co'",
    " ppmgap(1,1)=1.95",
    " ppmgap(2,1)=1.2",
    " echot=68",
    " $END",
    "",
  ].join("\n"));
  assert.deepEqual([LINE_BROADENING.widened.label, LINE_BROADENING.lcmodel.label], ["Widened", "LCModel defaults"]);
});

test("the control file refuses short spectra and empty fit ranges, and leaves out unknown TE and titles", () => {
  const base = { nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247 };
  assert.match(buildControl({ ...base, nunfil: 64 }), /\n nunfil=64\n/);
  for (const nunfil of [63, undefined, Number.NaN]) {
    assert.throws(() => buildControl({ ...base, nunfil }), { message: "The spectrum needs at least 64 points." });
  }
  assert.throws(() => buildControl({ ...base, ppmStart: 2, ppmEnd: 2 }), /fit range must run from a higher to a lower ppm/);
  for (const teMs of [0, -30, Number.NaN, undefined]) assert.doesNotMatch(buildControl({ ...base, teMs }), /echot/, String(teMs));
  assert.match(buildControl({ ...base, teMs: 0.5 }), /\n echot=0\.5\n/);
  assert.doesNotMatch(buildControl(base), /title/);
  const long = "x".repeat(130);
  assert.match(buildControl({ ...base, title: long }), new RegExp(`\\n title='${"x".repeat(120)}'\\n`));
});

const f13 = (values) => values.map((v) => v.toFixed(6).padStart(13)).join("");
const e13 = (values) => values.map((v) => v.toExponential(5).toUpperCase().padStart(13)).join("");
const PPM = Array.from({ length: 12 }, (_, k) => 4 - k * 0.25);
const series = (scale) => PPM.map((p, k) => scale * (k + 1));

/** A .COORD file in LCModel's Fortran formats (exes/lcmodel/src/finout.rs), numbers in rows of ten. */
function coordText({ data = series(1) } = {}) {
  const rows = (format, values) => [` ${format(values.slice(0, 10))}`, ` ${format(values.slice(10))}`].filter((line) => line.trim());
  return [
    " LCModel (Version 6.3-1N) Copyright: S.W. Provencher.",
    "  ",
    "  5 lines in following concentration table = NCONC+1",
    "    Conc.  %SD /NAA+NA  Metabolite",
    " 1.91E-06   5%   0.803 NAA",
    " 2.38E-06   3%   1.000 NAA+NAAG",
    "      NaN 999%     NaN Lip13a",
    " 1.00E-07  50%     NaN Ala",
    "   3 lines in following misc. output table",
    "  FWHM = 0.084 ppm    S/N =1234",
    "  Data shift =-0.012 ppm",
    "  Ph:-123 deg    -101.5 deg/ppm",
    "   12 points on ppm-axis = NY",
    ...rows(f13, PPM),
    " NY phased data points follow",
    ...rows(e13, data),
    " NY points of the fit to the data follow",
    ...rows(e13, series(2)),
    " NY background values follow",
    ...rows(e13, series(3)),
    " GABA     Conc. =-8.45E-09",
    ...rows(e13, series(4)),
    " Lip13a   Conc. = 2.00E-08",
    ...rows(e13, series(5)),
    "   3 lines in following diagnostic table:",
    "   3    info's RFALSI 12",
    "   1      info FINOUT  9",
    "",
    "   0 lines in following table of input changes:",
    "",
  ].join("\n");
}

test("every section of a .COORD file is read in LCModel's own number formats", () => {
  const coord = parseCoord(coordText());
  // The ratio column's name is cut to six characters; it is named in full.
  assert.equal(coord.ratioTo, "NAA+NAAG");
  assert.deepEqual(coord.rows, [
    { name: "NAA", concentration: 1.91e-6, sdPercent: 5, ratio: 0.803, combination: false },
    { name: "NAA+NAAG", concentration: 2.38e-6, sdPercent: 3, ratio: 1, combination: true },
    { name: "Ala", concentration: 1e-7, sdPercent: 50, ratio: null, combination: false },
  ]);
  assert.deepEqual(coord.misc, ["FWHM = 0.084 ppm    S/N =1234", "Data shift =-0.012 ppm", "Ph:-123 deg    -101.5 deg/ppm"]);
  assert.deepEqual(coord.summary, { fwhmPpm: 0.084, snr: 1234, shiftPpm: -0.012, phase0Deg: -123, phase1DegPerPpm: -101.5 });
  assert.deepEqual(coord.ppm, PPM);
  assert.deepEqual(coord.data, series(1));
  assert.deepEqual(coord.fit, series(2));
  assert.deepEqual(coord.background, series(3));
  assert.deepEqual(coord.metabolites, [
    { name: "GABA", concentration: -8.45e-9, curve: series(4) },
    { name: "Lip13a", concentration: 2e-8, curve: series(5) },
  ]);
  assert.deepEqual(coord.diagnostics, ["3    info's RFALSI 12", "1      info FINOUT  9"]);
  assert.deepEqual(coord.gaps, []);
});

test("a cut or empty .COORD file keeps what it has", () => {
  const text = coordText();
  // Cut after the first row of the last curve: its numbers so far, no diagnostics.
  const lines = text.split("\n");
  const curve = lines.indexOf(" Lip13a   Conc. = 2.00E-08");
  const cut = parseCoord(`${lines.slice(0, curve + 2).join("\n")}\n`);
  assert.deepEqual(cut.metabolites[1].curve, series(5).slice(0, 10));
  assert.deepEqual(cut.diagnostics, []);
  // A short section stops at the next heading rather than reading into it.
  const short = parseCoord(coordText({ data: series(1).slice(0, 5) }));
  assert.deepEqual(short.data, series(1).slice(0, 5));
  assert.deepEqual(short.fit, series(2));
  assert.deepEqual(parseCoord(""), {
    ratioTo: null,
    rows: [],
    misc: [],
    ppm: [],
    data: [],
    fit: [],
    background: [],
    metabolites: [],
    diagnostics: [],
    summary: { fwhmPpm: null, snr: null, shiftPpm: null, phase0Deg: null, phase1DegPerPpm: null },
    gaps: [],
  });
});

test("a PPMGAP window is a step more than five times the usual spacing", () => {
  assert.deepEqual(coordGaps([10, 9, 8, 7, 2, 1, 0]), [], "exactly five steps is not a gap");
  assert.deepEqual(coordGaps([10, 9, 8, 7, 1.5, 0.5, -0.5]), [{ hi: 7, lo: 1.5 }]);
  assert.deepEqual(coordGaps([4, 3.9, 3.8, 3.7, 3.6, 2, 1.9, 1.8, 0.4, 0.3]), [{ hi: 3.6, lo: 2 }, { hi: 1.8, lo: 0.4 }]);
  assert.deepEqual(coordGaps([1]), []);
  assert.deepEqual(coordGaps([]), []);
});

test("the .TABLE concentration section is read wherever it starts and however far it got", () => {
  const conc = (count) => `$$CONC${String(count).padStart(3)} lines in following concentration table = NCONC+1`;
  const header = "    Conc.  %SD /Cr+PCr  Metabolite";
  const full = parseTable([conc(4), header, " 1.20E-06  13%   0.659 Cr", " 6.22E-07  26%   0.341 PCr", " 1.83E-06   3%   1.000 Cr+PCr", "", "$$MISC  0 lines"].join("\n"));
  assert.equal(full.ratioTo, "Cr+PCr");
  assert.deepEqual(full.rows.map((r) => r.name), ["Cr", "PCr", "Cr+PCr"]);
  // A file that stops inside the table: the rows so far, the header's name as written.
  const cut = parseTable(["", conc(36), header, " 1.20E-06  13%   0.659 Cr", ""].join("\n"));
  assert.deepEqual([cut.ratioTo, cut.rows.map((r) => r.name)], ["Cr+PCr", ["Cr"]]);
  assert.deepEqual(parseTable(" LCModel (Version 6.3-1N)\n"), { ratioTo: null, rows: [] });
});

test("the concentration CSV quotes names and leaves missing ratios and notes empty", () => {
  const rows = [
    { name: "GABA+MM3co", concentration: 2.6e-5, sdPercent: 6, ratio: 0.296, note: "GABA+ (GABA + MM3co): primary result" },
    { name: 'Lip13, "a"', concentration: 1e-7, sdPercent: 50, ratio: null },
  ];
  assert.equal(concentrationsCsv(rows, null), [
    "Metabolite,Concentration,SD (%),Ratio,Note",
    "GABA+MM3co,0.000026,6,0.296,GABA+ (GABA + MM3co): primary result",
    '"Lip13, ""a""",1e-7,50,,',
    "",
  ].join("\n"));
  assert.equal(concentrationsCsv([rows[1]], "Cr"), 'Metabolite,Concentration,SD (%),/Cr\n"Lip13, ""a""",1e-7,50,\n');
});

test("a GABA+ fit without one of its parts still leads with GABA+", () => {
  const shown = presentRows([{ name: "NAA" }, { name: "GABA+MM3co" }, { name: "GABA" }]);
  assert.deepEqual(shown.map((r) => [r.name, r.primary, r.modelDependent, r.note]), [
    ["GABA+MM3co", true, false, "GABA+ (GABA + MM3co): primary result"],
    ["GABA", false, true, "model-dependent: split from MM3co by the macromolecule model"],
    ["NAA", undefined, undefined, undefined],
  ]);
  const mm = presentRows([{ name: "MM3co" }, { name: "GABA+MM3co" }]);
  assert.deepEqual(mm.map((r) => r.note), ["GABA+ (GABA + MM3co): primary result", "model-dependent: co-edited macromolecules under GABA at 3.0 ppm"]);
});

test("LCModel's stop codes are named, with the diagnostics from its table", () => {
  const hints = {
    "MYBASI 9": "The basis set was simulated for a different field strength.",
    "MYBASI 2": "The basis set's bandwidth is too narrow for these data.",
    "MYDATA 1": "The spectrum file could not be read.",
    "INITIA 4": "The fit range lies outside the spectrum.",
  };
  for (const [code, hint] of Object.entries(hints)) assert.equal(lcmodelError(`FATAL ERROR ${code}`), `LCModel stopped (FATAL ERROR ${code}). ${hint}`);
  const table = " LCModel\n$$DIAG  1 lines in following diagnostic table:\n   1     FATAL SETUP  3\n\n$$INPU  0 lines\n";
  const stopped = "LCModel stopped (FATAL ERROR SETUP 3).";
  assert.equal(lcmodelError("FATAL ERROR SETUP 3", { "result.coord": "", "result.table": table }), `${stopped} Diagnostics: 1 lines in following diagnostic table: 1 FATAL SETUP 3`);
  assert.equal(lcmodelError("FATAL ERROR SETUP 3", { "result.coord": table }), stopped);
  assert.equal(lcmodelError("FATAL ERROR SETUP 3", { "result.table": " LCModel\n" }), stopped);
});

test("diagnostic lines read in full, as LCModel aligns them", () => {
  const advice = "LCModel still fits, but coupled metabolites (Glu, Gln, GABA, Ins) can be biased: check the TE the scanner recorded, or supply a basis set simulated at the data's TE.";
  const both = explainDiagnostic("   1     ERROR MYBASI 10", { dataTeMs: 40.254, basisTeMs: 35 });
  assert.equal(both, `   1     ERROR MYBASI 10: the basis set's echo time (35 ms) differs from the data's (40.25 ms) by 3 ms or more. ${advice}`);
  const neither = explainDiagnostic("1 error MYBASI 10", { dataTeMs: 0, basisTeMs: Number.NaN });
  assert.equal(neither, `1 error MYBASI 10: the basis set's echo time differs from the data's by 3 ms or more. ${advice}`);
  assert.equal(explainDiagnostic("   1      info FINOUT  9"), "   1      info FINOUT  9 (LCModel information; the fit is unaffected)");
  assert.equal(explainDiagnostic("1 ERROR MYBASI 1"), "1 ERROR MYBASI 1 (see LCModel's manual, section 12, for MYBASI 1)");
  assert.equal(explainDiagnostic("1 ERROR SETUP 10"), "1 ERROR SETUP 10 (see LCModel's manual, section 12, for SETUP 10)");
  assert.equal(explainDiagnostic("1 FATAL MYBASI 10 in basis.basis"), "1 FATAL MYBASI 10 in basis.basis");
  // The .TABLE file pads each line with blanks.
  assert.equal(explainDiagnostic("2  warnings SPLINE 3   "), "2  warnings SPLINE 3    (see LCModel's manual, section 12, for SPLINE 3)");
});

test("a diagnostic table of ten lines or more is read whole", () => {
  const lines = Array.from({ length: 11 }, (_, k) => `   1   warning SPLINE ${k + 1}`);
  const text = coordText().replace(/ {3}3 lines in following diagnostic table:\n.*\n.*\n\n/, `  11 lines in following diagnostic table:\n${lines.join("\n")}\n`);
  assert.deepEqual(parseCoord(text).diagnostics, lines.map((line) => line.trim()));
});

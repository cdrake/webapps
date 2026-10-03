import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildControl, parseCoord, parseTable, concentrationsCsv, FILES } from "../src/lcmodel-io.js";
import { spectrumSvg, fitSeries, metaboliteSeries, visibleIndices, tickStep } from "../src/spectrum-plot.js";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);

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

test("a MEGA-PRESS fit can separate GABA from co-edited MM3co", () => {
  const options = { nunfil: 2080, deltat: 4.167e-4, hzpppm: 123.247, sptype: "mega-press-3", ppmStart: 4.2, ppmEnd: 0.5 };
  const mm = buildControl({ ...options, coEditedMM: true });
  assert.match(mm, /\n nsimul=2\n/);
  assert.match(mm, /chsimu\(1\)='MM09 @ \.915 /);
  // 14 Hz at 123.247 MHz is 0.114 ppm; the minimum Gaussian width is 10.5 Hz.
  assert.match(mm, /chsimu\(2\)='MM3co @ 3\.0 \+- \.02 FWHM= 0\.085 < 0\.114 \+- \.02 AMP= 2\.'/);
  assert.match(mm, /chrato\(2\)='MM3co\/MM09 = 1\. \+- \.2'/);
  assert.match(mm, /\n ncombi=18\n chcomb\(18\)='GABA\+MM3co'\n/);
  assert.doesNotMatch(buildControl(options), /MM3co/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: 2e-4, hzpppm: 123, coEditedMM: true }), /MEGA-PRESS/);
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
});

// LCModel's own files: the control file (NAMELIST /LCMODL/) the app writes,
// and the .COORD and .TABLE files LCModel writes back. Pure, Node-tested.

// Names the fit reads its inputs from; the worker supplies files under these.
export const FILES = Object.freeze({
  raw: "spectrum.raw",
  h2o: "water.h2o",
  basis: "basis.basis",
  table: "result.table",
  coord: "result.coord",
  csv: "result.csv",
});

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function number(value) {
  if (!Number.isFinite(value)) throw new Error(`LCModel needs a finite number, got ${value}`);
  return String(value);
}

/**
 * The control file for one fit.
 * @param {{
 *   nunfil: number, deltat: number, hzpppm: number, teMs?: number,
 *   water?: boolean, ecc?: boolean, ppmStart?: number, ppmEnd?: number,
 *   title?: string, key?: number,
 * }} options  `water` scales to the unsuppressed water reference (and
 *   enables eddy-current correction unless `ecc` is false).
 */
export function buildControl(options) {
  const {
    nunfil,
    deltat,
    hzpppm,
    teMs,
    water = false,
    ecc = water,
    ppmStart = 4.0,
    ppmEnd = 0.2,
    title = "",
  } = options;
  if (!(nunfil >= 64)) throw new Error("The spectrum needs at least 64 points.");
  if (!(ppmStart > ppmEnd)) throw new Error("The fit range must run from a higher to a lower ppm.");
  const lines = [
    " $LCMODL",
    // LCModel 6.3's licence key, required by the released source.
    " key=210387309",
    " lps=0",
    ` nunfil=${number(nunfil)}`,
    ` deltat=${number(deltat)}`,
    ` hzpppm=${number(hzpppm)}`,
    ` filbas=${quote(FILES.basis)}`,
    ` filraw=${quote(FILES.raw)}`,
    ` ppmst=${number(ppmStart)}`,
    ` ppmend=${number(ppmEnd)}`,
    ` lcoord=9`,
    ` filcoo=${quote(FILES.coord)}`,
    ` ltable=7`,
    ` filtab=${quote(FILES.table)}`,
    ` lcsv=11`,
    ` filcsv=${quote(FILES.csv)}`,
    // Individual metabolite curves in the .COORD file.
    " neach=99",
  ];
  if (Number.isFinite(teMs) && teMs > 0) lines.push(` echot=${number(teMs)}`);
  if (water) {
    lines.push(` filh2o=${quote(FILES.h2o)}`, " dows=T");
    lines.push(` doecc=${ecc ? "T" : "F"}`);
  }
  if (title) lines.push(` title=${quote(title.slice(0, 120))}`);
  lines.push(" $END", "");
  return lines.join("\n");
}

function numbersAfter(lines, start, count) {
  const values = [];
  for (let k = start; k < lines.length && values.length < count; k += 1) {
    for (const token of lines[k].trim().split(/\s+/)) {
      if (token === "") continue;
      const value = Number(token);
      if (!Number.isFinite(value)) return values;
      values.push(value);
    }
  }
  return values;
}

/** One row of LCModel's concentration table. */
function parseConcentrationRow(line) {
  const m = line.match(/^\s*(\S+)\s+(\d+)%\s+(\S+)\s+(.+?)\s*$/);
  if (!m) return null;
  const concentration = Number(m[1]);
  const ratio = Number(m[3]);
  if (!Number.isFinite(concentration)) return null;
  return {
    name: m[4],
    concentration,
    sdPercent: Number(m[2]),
    ratio: Number.isFinite(ratio) ? ratio : null,
    combination: m[4].includes("+"),
  };
}

function parseConcentrations(lines, start, count) {
  const header = lines[start] ?? "";
  const ratioTo = (header.match(/\/(\S+)/) ?? [])[1] ?? null;
  const rows = [];
  for (let k = start + 1; k < start + count && k < lines.length; k += 1) {
    const row = parseConcentrationRow(lines[k]);
    if (row) rows.push(row);
  }
  return { ratioTo, rows };
}

/**
 * The .COORD file: concentrations, the misc table (FWHM, S/N, shift, phase),
 * the ppm axis, data, fit, background and each metabolite's curve.
 */
export function parseCoord(text) {
  const lines = text.split(/\r?\n/);
  const result = { ratioTo: null, rows: [], misc: [], ppm: [], data: [], fit: [], background: [], metabolites: [], diagnostics: [] };
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    let m;
    if ((m = line.match(/^\s*(\d+) lines in following concentration table/))) {
      const table = parseConcentrations(lines, k + 1, Number(m[1]));
      result.ratioTo = table.ratioTo;
      result.rows = table.rows;
    } else if ((m = line.match(/^\s*(\d+) lines in following misc\. output table/))) {
      result.misc = lines.slice(k + 1, k + 1 + Number(m[1])).map((l) => l.trim());
    } else if ((m = line.match(/^\s*(\d+) lines in following diagnostic table/))) {
      result.diagnostics = lines.slice(k + 1, k + 1 + Number(m[1])).map((l) => l.trim()).filter(Boolean);
    } else if ((m = line.match(/^\s*(\d+) points on ppm-axis = NY/))) {
      result.ppm = numbersAfter(lines, k + 1, Number(m[1]));
    } else if (/NY phased data points follow/.test(line)) {
      result.data = numbersAfter(lines, k + 1, result.ppm.length);
    } else if (/NY points of the fit to the data follow/.test(line)) {
      result.fit = numbersAfter(lines, k + 1, result.ppm.length);
    } else if (/NY background values follow/.test(line)) {
      result.background = numbersAfter(lines, k + 1, result.ppm.length);
    } else if ((m = line.match(/^\s*(\S+)\s+Conc\. =\s*(\S+)/))) {
      result.metabolites.push({ name: m[1], concentration: Number(m[2]), curve: numbersAfter(lines, k + 1, result.ppm.length) });
    }
  }
  result.summary = summarizeMisc(result.misc);
  return result;
}

/** FWHM, S/N, data shift and phases from LCModel's misc table. */
export function summarizeMisc(misc) {
  const text = misc.join("\n");
  const get = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    fwhmPpm: get(/FWHM\s*=\s*([-\d.]+)\s*ppm/),
    snr: get(/S\/N\s*=\s*([-\d.]+)/),
    shiftPpm: get(/Data shift\s*=\s*([-\d.]+)/),
    phase0Deg: get(/Ph:\s*([-\d.]+)\s*deg/),
    phase1DegPerPpm: get(/deg\s+([-\d.]+)\s*deg\/ppm/),
  };
}

/** The concentration section of a .TABLE file. */
export function parseTable(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\$\$CONC/.test(l));
  if (start < 0) return { ratioTo: null, rows: [] };
  const count = Number((lines[start].match(/\$\$CONC\s*(\d+)/) ?? [])[1] ?? 0);
  return parseConcentrations(lines, start + 1, count);
}

/** The metabolite table as CSV (the app's own download). */
export function concentrationsCsv(rows, ratioTo) {
  const header = ["Metabolite", "Concentration", "SD (%)", ratioTo ? `/${ratioTo}` : "Ratio"];
  const cells = rows.map((r) => [r.name, r.concentration, r.sdPercent, r.ratio ?? ""]);
  return [header, ...cells].map((row) => row.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
}

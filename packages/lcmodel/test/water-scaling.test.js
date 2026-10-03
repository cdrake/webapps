// Ground truth for LCModel's water scaling with the library's FID-A basis sets.
// Synthetic data are built from the basis itself (8 mM Cr, 10 mM NAA, 5 Hz extra
// Lorentzian broadening, as in vivo) together with a water reference of 2 protons
// x WCONC x ATTH2O at the basis' per-proton amplitude (1 at t = 0 for FID-A
// simulations), so a correct pipeline returns Cr+PCr 8 and NAA+NAAG 10.
//
// With LCModel's defaults it returns 0.87 of that. Native gfortran LCModel
// 6.3-1N gives the same numbers, so this is LCModel's behaviour with these
// basis sets, not the port: the reference Cr singlet of a 1.5 Hz Lorentzian
// basis is integrated over +-5 FWHMBA only (RFWBAS = 10; 92 % of its area), and
// the prior on Lorentzian broadening (DESDT2 = 0.4) keeps the fit from
// following Lorentzian tails. With DESDT2 = 2 and RFWBAS = 80 it recovers both
// exactly. The first test is a todo until the defaults or the basis line shape
// change; the second pins the mechanism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadLcmodel } from "../src/wasm.js";

const basisPath = process.env.LCMODEL_BASIS ?? `${process.env.TMPDIR}/basis-out/press-3t-te35.basis`;

/** In-place radix-2 FFT (sign -1 forward, +1 inverse, unnormalised). */
function fft(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Each metabolite's FID in LCModel's time-domain convention (inverse of MYBASI's CFFT). */
function basisFids(text) {
  const badelt = Number(text.match(/BADELT\s*=\s*([-\d.eE+]+)/)[1]);
  const n = Number(text.match(/NDATAB\s*=\s*(\d+)/)[1]);
  const fids = {};
  for (const block of text.split(/\$BASIS\s*\n/).slice(1)) {
    const name = block.match(/METABO\s*=\s*'([^']+)'/)[1];
    const v = block.split("$END")[1].trim().split(/\s+/).slice(0, 2 * n).map(Number);
    const re = Float64Array.from({ length: n }, (_, k) => v[2 * k]);
    const im = Float64Array.from({ length: n }, (_, k) => v[2 * k + 1]);
    fft(re, im, 1);
    const s = 1 / Math.sqrt(n);
    fids[name] = { re: re.map((x) => x * s), im: im.map((x) => x * s) };
  }
  return { badelt, fids };
}

const line = (re, im) => `${re.toExponential(6).toUpperCase().padStart(15)}${im.toExponential(6).toUpperCase().padStart(15)}`;
const lcmText = (re, im) => [" $NMID", " id='SYN', fmtdat='(2E15.6)'", " volume=1.0", " tramp=1.0", " $END", ...Array.from(re, (r, k) => line(r, im[k]))].join("\n") + "\n";

async function fitSynthetic(basisText, extra) {
  const { badelt, fids } = basisFids(basisText);
  const n = 2048;
  const dt = 0.0005;
  const step = Math.round(dt / badelt);
  const hz = Number(basisText.match(/HZPPPM\s*=\s*([-\d.eE+]+)/)[1]);
  const met = { re: new Float64Array(n), im: new Float64Array(n) };
  const water = { re: new Float64Array(n), im: new Float64Array(n) };
  let seed = 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 0.004;
  };
  for (let k = 0; k < n; k += 1) {
    const t = k * dt;
    const lb = Math.exp(-Math.PI * 5 * t);
    const j = k * step;
    met.re[k] = (8 * fids.Cr.re[j] + 10 * fids.NAA.re[j]) * lb + noise();
    met.im[k] = (8 * fids.Cr.im[j] + 10 * fids.NAA.im[j]) * lb + noise();
    water.re[k] = 2 * 35880 * 0.7 * Math.exp(-Math.PI * 6.5 * t);
  }
  const control = [
    " $LCMODL", " key=210387309", " lps=0", ` nunfil=${n}`, ` deltat=${dt}`, ` hzpppm=${hz}`,
    " filbas='b.basis'", " filraw='m.raw'", " filh2o='w.h2o'", " dows=T", " doecc=F",
    " ltable=7", " filtab='out.table'", ...extra.map((e) => ` ${e}`), " $END", "",
  ].join("\n");
  const lcm = await loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)));
  const r = lcm.run({ control, files: { "b.basis": basisText, "m.raw": lcmText(met.re, met.im), "w.h2o": lcmText(water.re, water.im) } });
  assert.equal(r.error, null, r.error);
  const conc = (name) => Number(r.outputs["out.table"].split("\n").find((l) => l.trimEnd().endsWith(` ${name}`)).trim().split(/\s+/)[0]);
  return { cr: conc("Cr+PCr"), naa: conc("NAA+NAAG") };
}

async function basisOrSkip(t) {
  try {
    return await readFile(basisPath, "utf8");
  } catch {
    t.skip(`no FID-A basis set at ${basisPath} (set LCMODEL_BASIS)`);
    return null;
  }
}

test("water scaling returns the concentrations synthetic data were built with", { todo: "LCModel defaults recover 0.87 with the 1.5 Hz Lorentzian FID-A basis sets" }, async (t) => {
  const basis = await basisOrSkip(t);
  if (!basis) return;
  const { cr, naa } = await fitSynthetic(basis, []);
  assert.ok(Math.abs(cr / 8 - 1) < 0.03, `Cr+PCr ${cr}, built with 8`);
  assert.ok(Math.abs(naa / 10 - 1) < 0.03, `NAA+NAAG ${naa}, built with 10`);
});

test("the shortfall is LCModel's reference-singlet window and Lorentzian prior", async (t) => {
  const basis = await basisOrSkip(t);
  if (!basis) return;
  const defaults = await fitSynthetic(basis, []);
  assert.ok(Math.abs(defaults.cr / 8 - 0.872) < 0.01, `defaults: Cr+PCr ${defaults.cr}`);
  const open = await fitSynthetic(basis, ["desdt2=2", "rfwbas=80"]);
  assert.ok(Math.abs(open.cr / 8 - 1) < 0.01, `DESDT2 2, RFWBAS 80: Cr+PCr ${open.cr}`);
  assert.ok(Math.abs(open.naa / 10 - 1) < 0.01, `DESDT2 2, RFWBAS 80: NAA+NAAG ${open.naa}`);
});

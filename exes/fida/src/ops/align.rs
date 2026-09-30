//! Spectral registration: op_alignAverages, op_alignAverages_fd,
//! op_freqAlignAverages, op_alignISIS, op_alignMPSubspecs.

use num_complex::Complex64 as C;
use std::f64::consts::PI;

use super::averaging::{op_averaging, op_median};
use super::basic::op_freqrange;
use super::nlinfit::{nlinfit, NlinOpts};
use super::subspecs::{op_combinesubspecs, op_takesubspec, CombineMode};
use super::util::{colon, median, phasor_deg, spec, std};
use crate::spectra::Spectra;

/// What the averages are aligned to (FID-A's `med` argument).
#[derive(Clone, Copy, Debug)]
pub enum AlignTo<'a> {
    /// `'y'`: the median of the averages (op_alignAverages_fd: the mean).
    Median,
    /// `'a'`: the mean of the averages (op_alignAverages only).
    Average,
    /// `'n'`: the single average closest to the median.
    Best,
    /// `'r'`: an external reference.
    Ref(&'a Spectra),
}

/// Frequency (Hz) and phase (degrees) per average (rows) and subspectrum
/// (columns), column-major.
#[derive(Clone, Debug)]
pub struct Alignment {
    pub out: Spectra,
    pub fs: Vec<f64>,
    pub phs: Vec<f64>,
    pub n_averages: usize,
    pub n_subspecs: usize,
    /// The average used as reference with `AlignTo::Best` (0-based, per subspectrum).
    pub reference: Vec<Option<usize>>,
}

fn fid3(s: &Spectra, n: usize, m: usize) -> &[C] {
    let nt = s.n();
    let na = s.size(2);
    let k = n + na * m;
    &s.fids[nt * k..nt * (k + 1)]
}

fn stack(z: &[C]) -> Vec<f64> {
    z.iter().map(|v| v.re).chain(z.iter().map(|v| v.im)).collect()
}

/// `addphase(fid .* exp(sign*1i*t'*f*2*pi), p)` into `out` as [real; imag].
fn shifted_stack(fid: &[C], t: &[f64], f: f64, p: f64, sign: f64, out: &mut [f64]) {
    let l = fid.len();
    let z = phasor_deg(p);
    for k in 0..l {
        let v = fid[k] * C::new(0.0, sign * t[k] * f * 2.0 * PI).exp() * z;
        out[k] = v.re;
        out[k + l] = v.im;
    }
}

fn shift_full(fid: &[C], dt: f64, f: f64, p: f64, sign: f64) -> Vec<C> {
    let t = colon(0.0, dt, (fid.len() as f64 - 1.0) * dt);
    let z = phasor_deg(p);
    fid.iter().zip(&t).map(|(v, tk)| v * C::new(0.0, sign * tk * f * 2.0 * PI).exp() * z).collect()
}

fn check_combined(input: &Spectra) -> Result<(), String> {
    if !input.flags.addedrcvrs {
        return Err("Combine the receiver channels (op_addrcvrs) before aligning.".into());
    }
    Ok(())
}

fn best_average(input: &Spectra, tmax: f64, b: usize, m: usize) -> usize {
    let inavg = op_median(input);
    let nt = input.n();
    let na = input.size(2);
    let tr: Vec<usize> = (0..nt).filter(|&i| input.t[i] >= 0.0 && input.t[i] <= tmax).collect();
    let tra: Vec<usize> = (0..inavg.n()).filter(|&i| inavg.t[i] >= 0.0 && inavg.t[i] <= tmax).collect();
    let _ = b;
    let mut best = 0;
    let mut bestv = f64::INFINITY;
    for k in 0..na {
        let f = fid3(input, k, m);
        let g = &inavg.fids[inavg.n() * m..inavg.n() * (m + 1)];
        let s: f64 = tr.iter().zip(&tra).map(|(&i, &j)| (f[i].re - g[j].re).powi(2)).sum();
        if s < bestv {
            bestv = s;
            best = k;
        }
    }
    best
}

/// op_alignAverages: time-domain spectral registration (Near et al. 2015)
/// of every average to a reference over `0 <= t < tmax`. With `tmax` `None`
/// it is estimated as FID-A does (median time at which the SNR of each FID
/// drops to 5).
pub fn op_align_averages(input: &Spectra, tmax: Option<f64>, to: AlignTo) -> Result<Alignment, String> {
    check_combined(input)?;
    if input.dims.averages == 0 {
        return Ok(Alignment { out: input.clone(), fs: vec![0.0], phs: vec![0.0], n_averages: 1, n_subspecs: 1, reference: vec![None] });
    }
    if input.dims.averages != 2 {
        return Err("op_alignAverages expects the averages in the second dimension.".into());
    }
    let tmax = match tmax {
        Some(t) => t,
        None => estimate_tmax(input)?,
    };
    let opts = NlinOpts::fida_align();
    let b = if input.dims.sub_specs == 0 { 1 } else { input.size(input.dims.sub_specs) };
    let na = input.size(2);
    let nt = input.n();
    let mask: Vec<usize> = (0..nt).filter(|&i| input.t[i] >= 0.0 && input.t[i] < tmax).collect();
    let l = mask.len();
    let tl = colon(0.0, input.dwelltime, (l as f64 - 1.0) * input.dwelltime);
    let mut fs = vec![0.0; na * b];
    let mut phs = vec![0.0; na * b];
    let mut fids = vec![C::new(0.0, 0.0); nt * na * b];
    let mut reference = vec![None; b];
    let mut pars = vec![0.0, 0.0];
    let med = match to {
        AlignTo::Median => Some(op_median(input)),
        AlignTo::Average => Some(op_averaging(input)),
        _ => None,
    };
    for m in 0..b {
        let (base, ind) = match to {
            AlignTo::Median | AlignTo::Average => {
                let s = med.as_ref().unwrap();
                (stack(&mask.iter().map(|&i| s.fids[i + s.n() * m]).collect::<Vec<_>>()), None)
            }
            AlignTo::Best => {
                let k = best_average(input, tmax, b, m);
                let f = fid3(input, k, m);
                let dst = nt * (k + na * m);
                fids[dst..dst + nt].copy_from_slice(f);
                (stack(&mask.iter().map(|&i| f[i]).collect::<Vec<_>>()), Some(k))
            }
            AlignTo::Ref(r) => (stack(&mask.iter().map(|&i| r.fids[i + r.n() * m]).collect::<Vec<_>>()), None),
        };
        reference[m] = ind;
        for n in 0..na {
            if Some(n) == ind {
                continue;
            }
            let f = fid3(input, n, m);
            let x: Vec<C> = mask.iter().map(|&i| f[i]).collect();
            let mut model = |p: &[f64], out: &mut [f64]| shifted_stack(&x, &tl, p[0], p[1], 1.0, out);
            let fit = nlinfit(&base, &mut model, &pars, &opts, None);
            pars = fit.beta;
            let dst = nt * (n + na * m);
            fids[dst..dst + nt].copy_from_slice(&shift_full(f, input.dwelltime, pars[0], pars[1], 1.0));
            fs[n + na * m] = pars[0];
            phs[n + na * m] = pars[1];
        }
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz = super::util::trim(&[nt, na, b]);
    out.flags.writtentostruct = true;
    out.flags.freqcorrected = true;
    Ok(Alignment { out, fs, phs, n_averages: na, n_subspecs: b, reference })
}

fn estimate_tmax(input: &Spectra) -> Result<f64, String> {
    let nt = input.n();
    let first = ((0.75 * nt as f64).ceil() as usize).max(1) - 1;
    let nf = input.n_fids();
    let mut noise = 0.0;
    for k in 0..nf {
        let v: Vec<f64> = input.fid(k)[first..].iter().map(|z| z.re).collect();
        noise += std(&v);
    }
    noise /= nf as f64;
    let mut est = Vec::with_capacity(nf);
    for k in 0..nf {
        let f = input.fid(k);
        match (0..nt).rev().find(|&i| f[i].norm() / noise > 5.0) {
            Some(i) => est.push(input.t[i]),
            None => return Err("Could not estimate tmax: no FID rises above 5 times the noise.".into()),
        }
    }
    Ok(median(&est))
}

/// op_alignAverages_fd: spectral registration restricted to
/// `minppm < ppm < maxppm` (the data are band-limited with op_freqrange and
/// aligned over `0 <= t < tmax` of the band-limited FID). `AlignTo::Median`
/// is FID-A's `'y'`, which here aligns to the *mean* of the averages.
pub fn op_align_averages_fd(input: &Spectra, minppm: f64, maxppm: f64, tmax: f64, to: AlignTo) -> Result<Alignment, String> {
    check_combined(input)?;
    if input.dims.averages != 2 {
        return Err("op_alignAverages_fd expects the averages in the second dimension.".into());
    }
    if matches!(to, AlignTo::Average) {
        return Err("op_alignAverages_fd has no 'a' mode.".into());
    }
    let opts = NlinOpts::fida_align();
    let b = if input.dims.sub_specs == 0 { 1 } else { input.size(input.dims.sub_specs) };
    let na = input.size(2);
    let nt = input.n();
    let datarange = op_freqrange(input, minppm, maxppm)?;
    let nr = datarange.n();
    let dmask: Vec<usize> = (0..nr).filter(|&i| datarange.t[i] >= 0.0 && datarange.t[i] < tmax).collect();
    let l = dmask.len();
    let tl = colon(0.0, datarange.dwelltime, (l as f64 - 1.0) * datarange.dwelltime);
    let mut fs = vec![0.0; na * b];
    let mut phs = vec![0.0; na * b];
    let mut fids = vec![C::new(0.0, 0.0); nt * na * b];
    let mut reference = vec![None; b];
    let mut pars = vec![0.0, 0.0];
    let base_struct = match to {
        AlignTo::Median => Some(op_freqrange(&op_averaging(input), minppm, maxppm)?),
        AlignTo::Ref(r) => Some(op_freqrange(r, minppm, maxppm)?),
        _ => None,
    };
    for m in 0..b {
        let (base, ind) = match to {
            AlignTo::Best => {
                let k = best_average(input, tmax, b, m);
                let dst = nt * (k + na * m);
                fids[dst..dst + nt].copy_from_slice(fid3(input, k, m));
                let f = fid3(&datarange, k, m);
                (stack(&dmask.iter().map(|&i| f[i]).collect::<Vec<_>>()), Some(k))
            }
            _ => {
                let s = base_struct.as_ref().unwrap();
                let bm: Vec<usize> = (0..s.n()).filter(|&i| s.t[i] >= 0.0 && s.t[i] < tmax).collect();
                (stack(&bm.iter().map(|&i| s.fids[i + s.n() * m]).collect::<Vec<_>>()), None)
            }
        };
        reference[m] = ind;
        for n in 0..na {
            if Some(n) == ind {
                continue;
            }
            let f = fid3(&datarange, n, m);
            let x: Vec<C> = dmask.iter().map(|&i| f[i]).collect();
            let mut model = |p: &[f64], out: &mut [f64]| shifted_stack(&x, &tl, p[0], p[1], 1.0, out);
            let fit = nlinfit(&base, &mut model, &pars, &opts, None);
            pars = fit.beta;
            let dst = nt * (n + na * m);
            fids[dst..dst + nt].copy_from_slice(&shift_full(fid3(input, n, m), input.dwelltime, pars[0], pars[1], 1.0));
            fs[n + na * m] = pars[0];
            phs[n + na * m] = pars[1];
        }
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz = super::util::trim(&[nt, na, b]);
    out.flags.writtentostruct = true;
    out.flags.freqcorrected = true;
    Ok(Alignment { out, fs, phs, n_averages: na, n_subspecs: b, reference })
}

/// op_freqAlignAverages: frequency-only registration over `0 <= t < tmax`,
/// to the mean of the averages (`to_average`) or to the first average.
/// `init` is the starting frequency (default 0). Uses nlinfit's default
/// options (MaxIter 100).
pub fn op_freq_align_averages(input: &Spectra, tmax: f64, to_average: bool, init: Option<f64>) -> Result<Alignment, String> {
    check_combined(input)?;
    if input.dims.averages != 2 {
        return Err("op_freqAlignAverages expects the averages in the second dimension.".into());
    }
    let opts = NlinOpts::default();
    let b = if input.dims.sub_specs == 0 { 1 } else { input.size(input.dims.sub_specs) };
    let na = input.size(2);
    let nt = input.n();
    let mask: Vec<usize> = (0..nt).filter(|&i| input.t[i] >= 0.0 && input.t[i] < tmax).collect();
    let l = mask.len();
    let tl = colon(0.0, input.dwelltime, (l as f64 - 1.0) * input.dwelltime);
    let mut fs = vec![0.0; na * b];
    let mut fids = vec![C::new(0.0, 0.0); nt * na * b];
    let mut pars = vec![init.unwrap_or(0.0)];
    let av = if to_average { Some(op_averaging(input)) } else { None };
    for m in 0..b {
        let (base, begin) = if let Some(s) = av.as_ref() {
            (stack(&mask.iter().map(|&i| s.fids[i + s.n() * m]).collect::<Vec<_>>()), 0)
        } else {
            let f = fid3(input, 0, m);
            let dst = nt * (na * m);
            fids[dst..dst + nt].copy_from_slice(f);
            (stack(&mask.iter().map(|&i| f[i]).collect::<Vec<_>>()), 1)
        };
        for n in begin..na {
            let f = fid3(input, n, m);
            let x: Vec<C> = mask.iter().map(|&i| f[i]).collect();
            let mut model = |p: &[f64], out: &mut [f64]| shifted_stack(&x, &tl, p[0], 0.0, 1.0, out);
            let fit = nlinfit(&base, &mut model, &pars, &opts, None);
            pars = fit.beta;
            let dst = nt * (n + na * m);
            fids[dst..dst + nt].copy_from_slice(&shift_full(f, input.dwelltime, pars[0], 0.0, 1.0));
            fs[n + na * m] = pars[0];
        }
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz = super::util::trim(&[nt, na, b]);
    out.flags.writtentostruct = true;
    out.flags.freqcorrected = true;
    Ok(Alignment { out, phs: vec![0.0; fs.len()], fs, n_averages: na, n_subspecs: b, reference: vec![None; b] })
}

/// op_alignISIS: align the second subspectrum of every average to the first
/// so that their sum matches the median ISIS-combined spectrum over
/// `0 <= t < tmax` (SPECIAL). Every average starts from `init` (default
/// [0, 0]); nlinfit's default options (MaxIter 100).
pub fn op_align_isis(input: &Spectra, tmax: f64, init: Option<[f64; 2]>) -> Result<Alignment, String> {
    check_combined(input)?;
    if input.dims.sub_specs == 0 {
        return Err("op_alignISIS needs multiple subspectra.".into());
    }
    if input.size(input.dims.sub_specs) != 2 {
        return Err("op_alignISIS needs exactly two subspectra.".into());
    }
    let opts = NlinOpts::default();
    let guess = init.unwrap_or([0.0, 0.0]).to_vec();
    let nt = input.n();
    let has_avg = input.dims.averages > 0;
    if has_avg && (input.dims.averages != 2 || input.dims.sub_specs != 3) {
        return Err("op_alignISIS expects [time, averages, subspectra].".into());
    }
    let na = if has_avg { input.size(2) } else { 1 };
    let comb = op_combinesubspecs(input, CombineMode::Diff)?;
    let base0 = if has_avg { op_median(&comb) } else { comb };
    let bmask: Vec<usize> = (0..base0.n()).filter(|&i| base0.t[i] >= 0.0 && base0.t[i] < tmax).collect();
    let base = stack(&bmask.iter().map(|&i| base0.fids[i]).collect::<Vec<_>>());
    let mask: Vec<usize> = (0..nt).filter(|&i| input.t[i] >= 0.0 && input.t[i] < tmax).collect();
    let l = mask.len();
    let tl = colon(0.0, input.dwelltime, (l as f64 - 1.0) * input.dwelltime);
    let mut fs = vec![0.0; na];
    let mut phs = vec![0.0; na];
    let mut fids = vec![C::new(0.0, 0.0); nt * na * 2];
    for n in 0..na {
        let f1 = &input.fids[nt * n..nt * (n + 1)];
        let f2 = &input.fids[nt * (n + na)..nt * (n + na + 1)];
        let x1: Vec<C> = mask.iter().map(|&i| f1[i]).collect();
        let x2: Vec<C> = mask.iter().map(|&i| f2[i]).collect();
        let mut model = |p: &[f64], out: &mut [f64]| {
            let z = phasor_deg(p[1]);
            for k in 0..l {
                let s = x2[k] * C::new(0.0, -tl[k] * p[0] * 2.0 * PI).exp() * z;
                let v = (x1[k] + s) / 2.0;
                out[k] = v.re;
                out[k + l] = v.im;
            }
        };
        let fit = nlinfit(&base, &mut model, &guess, &opts, None);
        let p = fit.beta;
        fids[nt * n..nt * (n + 1)].copy_from_slice(f1);
        fids[nt * (n + na)..nt * (n + na + 1)].copy_from_slice(&shift_full(f2, input.dwelltime, p[0], p[1], -1.0));
        fs[n] = p[0];
        phs[n] = p[1];
    }
    let mut out = input.clone();
    out.fids = fids;
    out.flags.writtentostruct = true;
    out.flags.freqcorrected = true;
    Ok(Alignment { out, fs, phs, n_averages: na, n_subspecs: 1, reference: vec![None] })
}

/// op_alignMPSubspecs: align the edit-ON subspectrum (2) of averaged
/// MEGA-PRESS data to edit-OFF (1) in the frequency domain, with optional
/// per-point `ppm_weights` (default uniform). `in_phase` is FID-A's `'i'`
/// mode; the default `'o'` adds 180 degrees to the aligned subspectrum.
pub fn op_align_mp_subspecs(input: &Spectra, in_phase: bool, init: Option<[f64; 2]>, ppm_weights: Option<&[f64]>) -> Result<(Spectra, f64, f64), String> {
    check_combined(input)?;
    if input.dims.sub_specs == 0 {
        return Err("op_alignMPSubspecs needs multiple subspectra.".into());
    }
    if input.dims.averages != 0 {
        return Err("Average the data before op_alignMPSubspecs.".into());
    }
    let nt = input.n();
    let mut w: Vec<f64> = match ppm_weights {
        Some(w) => w.to_vec(),
        None => vec![1.0; input.ppm.len()],
    };
    let tot: f64 = w.iter().sum();
    for v in w.iter_mut() {
        *v /= tot;
    }
    if w.len() != input.ppm.len() || w.iter().any(|&v| v <= 0.0) {
        return Err("ppmWeights must be real positive weights, one per ppm point.".into());
    }
    let ph_shift = if in_phase { 0.0 } else { 180.0 };
    let base0 = op_takesubspec(input, &[0])?;
    let base = stack(&spec(&base0.fids[..nt]));
    let weights: Vec<f64> = w.iter().chain(w.iter()).copied().collect();
    let x = &input.fids[nt..2 * nt];
    let t = input.t.clone();
    let mut model = |p: &[f64], out: &mut [f64]| {
        let z = phasor_deg(p[1]);
        let sh: Vec<C> = x.iter().zip(&t).map(|(v, tk)| v * C::new(0.0, -tk * p[0] * 2.0 * PI).exp() * z).collect();
        let s = spec(&sh);
        for k in 0..nt {
            out[k] = s[k].re;
            out[k + nt] = s[k].im;
        }
    };
    let fit = nlinfit(&base, &mut model, &init.unwrap_or([0.0, 0.0]), &NlinOpts::fida_align(), Some(&weights));
    let p = fit.beta;
    let z = phasor_deg(p[1] + ph_shift);
    let a: Vec<C> = x.iter().zip(&input.t).map(|(v, tk)| v * C::new(0.0, -tk * p[0] * 2.0 * PI).exp() * z).collect();
    let mut out = input.clone();
    out.fids = input.fids[..nt].to_vec();
    out.fids.extend(a);
    out.sz = vec![nt, 2];
    out.flags.writtentostruct = true;
    out.flags.freqcorrected = true;
    Ok((out, p[0], p[1] + ph_shift))
}

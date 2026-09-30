//! Point-wise and axis operations: op_leftshift, op_zeropad, op_filter,
//! op_freqrange, op_timerange, op_addphase, op_freqshift, op_autophase,
//! op_ppmref, op_ampScale, op_complexConj.

use num_complex::Complex64 as C;
use std::f64::consts::PI;

use super::util::{fid_from_spec, find_max, phase1, phasor_deg, ppm_axis, spec, t_axis};
use crate::spectra::Spectra;

/// op_leftshift: drop the first `ls` points of every FID. FID-A asks for
/// confirmation when the data were already left-shifted; this proceeds.
pub fn op_leftshift(input: &Spectra, ls: usize) -> Result<Spectra, String> {
    let n = input.n();
    if ls >= n {
        return Err(format!("Cannot left-shift {ls} points out of a {n}-point FID."));
    }
    let m = n - ls;
    let mut fids = Vec::with_capacity(m * input.n_fids());
    for k in 0..input.n_fids() {
        fids.extend_from_slice(&input.fid(k)[ls..]);
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz[0] = m;
    out.ppm = ppm_axis(m, input.spectralwidth, input.bo);
    out.t = t_axis(m, input.dwelltime);
    out.flags.writtentostruct = true;
    out.flags.leftshifted = true;
    Ok(out)
}

/// op_zeropad: append `ceil(n*zp_factor - n)` zeros to every FID. FID-A asks
/// for confirmation when the data were already zero-filled; this proceeds.
pub fn op_zeropad(input: &Spectra, zp_factor: f64) -> Spectra {
    let n = input.n();
    let zp = ((n as f64 * zp_factor) - n as f64).ceil().max(0.0) as usize;
    let m = n + zp;
    let mut fids = Vec::with_capacity(m * input.n_fids());
    for k in 0..input.n_fids() {
        fids.extend_from_slice(input.fid(k));
        fids.extend(std::iter::repeat(C::new(0.0, 0.0)).take(zp));
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz[0] = m;
    out.ppm = ppm_axis(m, input.spectralwidth, input.bo);
    out.t = t_axis(m, input.dwelltime);
    out.flags.writtentostruct = true;
    out.flags.zeropadded = true;
    out
}

/// op_filter: exponential line broadening by `lb` Hz (`exp(-t*pi*lb)`).
pub fn op_filter(input: &Spectra, lb: f64) -> Spectra {
    if lb == 0.0 {
        return input.clone();
    }
    let t2 = 1.0 / (PI * lb);
    let lor: Vec<f64> = input.t.iter().map(|t| (-t / t2).exp()).collect();
    let mut out = input.clone();
    let n = input.n();
    for k in 0..input.n_fids() {
        for (v, l) in out.fids[k * n..(k + 1) * n].iter_mut().zip(&lor) {
            *v *= l;
        }
    }
    out.flags.writtentostruct = true;
    out.flags.filtered = true;
    out
}

/// The part of op_freqrange that selects the spectra: every spectrum
/// restricted to `ppmmin < ppm < ppmmax`, with its ppm axis.
pub fn freqrange_specs(input: &Spectra, ppmmin: f64, ppmmax: f64) -> (Vec<C>, Vec<f64>, usize) {
    let mask: Vec<usize> = (0..input.ppm.len()).filter(|&i| input.ppm[i] > ppmmin && input.ppm[i] < ppmmax).collect();
    let n = input.n();
    let mut specs = Vec::with_capacity(mask.len() * input.n_fids());
    for k in 0..input.n_fids() {
        let s = spec(&input.fids[k * n..(k + 1) * n]);
        specs.extend(mask.iter().map(|&i| s[i]));
    }
    let ppm = mask.iter().map(|&i| input.ppm[i]).collect();
    (specs, ppm, mask.len())
}

/// op_freqrange: keep `ppmmin < ppm < ppmmax`, with the spectral width and
/// dwell time of the narrower band.
pub fn op_freqrange(input: &Spectra, ppmmin: f64, ppmmax: f64) -> Result<Spectra, String> {
    let (specs, ppm, m) = freqrange_specs(input, ppmmin, ppmmax);
    if m < 2 {
        return Err(format!("The range {ppmmin}-{ppmmax} ppm holds fewer than two spectral points."));
    }
    let mut fids = Vec::with_capacity(specs.len());
    for k in 0..input.n_fids() {
        fids.extend(fid_from_spec(&specs[k * m..(k + 1) * m]));
    }
    let dppm = (ppm[1] - ppm[0]).abs();
    let ppmrange = (ppm[m - 1] - ppm[0]).abs() + dppm;
    let sw = ppmrange * input.bo * 42.577;
    let dt = 1.0 / sw;
    let mut out = input.clone();
    out.fids = fids;
    out.sz[0] = m;
    out.ppm = ppm;
    out.t = t_axis(m, dt);
    out.spectralwidth = sw;
    out.dwelltime = dt;
    out.flags.writtentostruct = true;
    Ok(out)
}

/// op_timerange: keep `tmin <= t < tmax`; the time axis restarts at 0.
pub fn op_timerange(input: &Spectra, tmin: f64, tmax: f64) -> Result<Spectra, String> {
    let keep: Vec<usize> = (0..input.t.len()).filter(|&i| input.t[i] >= tmin && input.t[i] < tmax).collect();
    if keep.is_empty() {
        return Err(format!("No time points between {tmin} and {tmax} s."));
    }
    let n = input.n();
    let m = keep.len();
    let mut fids = Vec::with_capacity(m * input.n_fids());
    for k in 0..input.n_fids() {
        fids.extend(keep.iter().map(|&i| input.fids[k * n + i]));
    }
    let mut out = input.clone();
    out.fids = fids;
    out.sz[0] = m;
    out.ppm = ppm_axis(m, input.spectralwidth, input.bo);
    out.t = t_axis(m, input.dwelltime);
    out.flags.writtentostruct = true;
    Ok(out)
}

/// op_addphase: zero-order phase `ph0` (degrees) and first-order phase `ph1`
/// (seconds, about `ppm0`, default 4.65). With `ph1 == 0` FID-A's FFT round
/// trip multiplies by exactly 1, so it is skipped.
pub fn op_addphase(input: &Spectra, ph0: f64, ph1: f64, ppm0: f64) -> Spectra {
    let z = phasor_deg(ph0);
    let mut out = input.clone();
    for v in out.fids.iter_mut() {
        *v *= z;
    }
    if ph1 != 0.0 {
        let n = input.n();
        let f: Vec<C> = input
            .ppm
            .iter()
            .map(|p| {
                let phas = (p - ppm0) * 42.577 * input.bo * ph1 * 2.0 * PI;
                C::new(0.0, -phas).exp()
            })
            .collect();
        for k in 0..input.n_fids() {
            let mut s = spec(&out.fids[k * n..(k + 1) * n]);
            for (v, w) in s.iter_mut().zip(&f) {
                *v *= w;
            }
            let back = fid_from_spec(&s);
            out.fids[k * n..(k + 1) * n].copy_from_slice(&back);
        }
    }
    out.flags.writtentostruct = true;
    out
}

/// op_freqshift: shift by `f` Hz (`fids .* exp(-1i*t*f*2*pi)`).
pub fn op_freqshift(input: &Spectra, f: f64) -> Spectra {
    let w: Vec<C> = input.t.iter().map(|t| C::new(0.0, -t * f * 2.0 * PI).exp()).collect();
    let mut out = input.clone();
    let n = input.n();
    for k in 0..input.n_fids() {
        for (v, e) in out.fids[k * n..(k + 1) * n].iter_mut().zip(&w) {
            *v *= e;
        }
    }
    out
}

fn single_spectrum(input: &Spectra, what: &str, dim_num: Option<usize>) -> Result<usize, String> {
    if input.dims.coils > 0 {
        return Err(format!("{what} cannot operate on data with multiple coils; combine them first."));
    }
    if input.dims.averages > 0 {
        return Err(format!("{what} cannot operate on data with multiple averages; average them first."));
    }
    if input.dims.extras > 0 {
        return Err(format!("{what} cannot operate on data with an extras dimension."));
    }
    if input.dims.sub_specs > 0 {
        // FID-A asks the user which subspectrum to use.
        match dim_num {
            Some(d) if d >= 1 && d <= input.size(input.dims.sub_specs) => Ok(d - 1),
            _ => Err(format!("{what} needs the subspectrum to use (1..{}).", input.size(input.dims.sub_specs))),
        }
    } else {
        Ok(0)
    }
}

/// op_autophase: zero-order phase that makes the largest peak between
/// `ppmmin` and `ppmmax` real and positive, plus `ph` degrees. `dim_num`
/// (1-based) picks the subspectrum FID-A would ask for. Returns the phased
/// data and the phase added (degrees).
pub fn op_autophase(input: &Spectra, ppmmin: f64, ppmmax: f64, ph: f64, dim_num: Option<usize>) -> Result<(Spectra, f64), String> {
    let d = single_spectrum(input, "op_autophase", dim_num)?;
    let zp;
    let src = if !input.flags.zeropadded {
        zp = op_zeropad(input, 10.0);
        &zp
    } else {
        input
    };
    let (specs, _, m) = freqrange_specs(src, ppmmin, ppmmax);
    if m == 0 {
        return Err(format!("No spectral points between {ppmmin} and {ppmmax} ppm."));
    }
    let col = &specs[d * m..(d + 1) * m];
    let mags: Vec<f64> = col.iter().map(|z| z.norm()).collect();
    let idx = find_max(&mags)[0];
    let ph0 = -phase1(col[idx]) * 180.0 / PI;
    let sh = ph0 + ph;
    Ok((op_addphase(input, sh, 0.0, 4.65), sh))
}

/// op_ppmref: shift the largest peak between `ppmmin` and `ppmmax` to
/// `ppmrefval`. Returns the shifted data and the shift in Hz.
pub fn op_ppmref(input: &Spectra, ppmmin: f64, ppmmax: f64, ppmrefval: f64, dim_num: Option<usize>) -> Result<(Spectra, f64), String> {
    let d = single_spectrum(input, "op_ppmref", dim_num)?;
    let zp;
    let src = if !input.flags.zeropadded {
        zp = op_zeropad(input, 10.0);
        &zp
    } else {
        input
    };
    let (specs, ppm, m) = freqrange_specs(src, ppmmin, ppmmax);
    if m == 0 {
        return Err(format!("No spectral points between {ppmmin} and {ppmmax} ppm."));
    }
    let col = &specs[d * m..(d + 1) * m];
    let mags: Vec<f64> = col.iter().map(|z| z.norm()).collect();
    let idx = find_max(&mags)[0];
    let frqshift = (ppm[idx] - ppmrefval) * input.txfrq / 1e6;
    Ok((op_freqshift(input, frqshift), frqshift))
}

/// op_ampScale: multiply by `a`.
pub fn op_amp_scale(input: &Spectra, a: f64) -> Spectra {
    let mut out = input.clone();
    for v in out.fids.iter_mut() {
        *v *= a;
    }
    out
}

/// op_complexConj: complex conjugate of the FIDs.
pub fn op_complex_conj(input: &Spectra) -> Spectra {
    let mut out = input.clone();
    for v in out.fids.iter_mut() {
        *v = v.conj();
    }
    out.flags.writtentostruct = true;
    out
}

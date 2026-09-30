//! Quality measures: op_getSNR, op_getLW (with op_lorentz).

use num_complex::Complex64 as C;

use super::basic::op_zeropad;
use super::nlinfit::{nlinfit, NlinOpts};
use super::util::{mean, phasor_deg, polyfit_c, polyval_c, spec, std};
use crate::spectra::Spectra;

/// op_getSNR result.
#[derive(Clone, Copy, Debug)]
pub struct Snr {
    pub snr: f64,
    pub signal: f64,
    pub noise_sd: f64,
}

/// op_getSNR: peak magnitude between `naa_min` and `naa_max` ppm (defaults
/// 1.8-2.2), less the mean real noise, over the standard deviation of the real
/// noise after removing a quadratic baseline between `noise_min` and
/// `noise_max` (defaults -2-0). Uses the first spectrum.
pub fn op_get_snr(input: &Spectra, naa_min: f64, naa_max: f64, noise_min: f64, noise_max: f64) -> Result<Snr, String> {
    let s = spec(&input.fids[..input.n()]);
    let ppm = &input.ppm;
    let win: Vec<C> = (0..s.len()).filter(|&i| ppm[i] > naa_min && ppm[i] < naa_max).map(|i| s[i]).collect();
    if win.is_empty() {
        return Err(format!("No spectral points between {naa_min} and {naa_max} ppm."));
    }
    let max_naa = win.iter().map(|z| z.norm()).fold(f64::NEG_INFINITY, f64::max);
    let idx: Vec<usize> = (0..s.len()).filter(|&i| ppm[i] > noise_min && ppm[i] < noise_max).collect();
    if idx.len() < 3 {
        return Err(format!("Fewer than three noise points between {noise_min} and {noise_max} ppm."));
    }
    let nw: Vec<C> = idx.iter().map(|&i| s[i]).collect();
    let px: Vec<f64> = idx.iter().map(|&i| ppm[i]).collect();
    let p = polyfit_c(&px, &nw, 2);
    let noise: Vec<f64> = nw.iter().zip(&px).map(|(v, &x)| (v - polyval_c(&p, x)).re).collect();
    let re: Vec<f64> = nw.iter().map(|z| z.re).collect();
    let signal = max_naa - mean(&re);
    let noise_sd = std(&noise);
    Ok(Snr { snr: signal / noise_sd, signal, noise_sd })
}

/// op_lorentz with five parameters [amplitude, FWHM (ppm), centre (ppm),
/// baseline, phase (degrees)]: the real part of a phased, peak-normalised
/// complex Lorentzian.
pub fn op_lorentz(pars: &[f64], ppm: &[f64], out: &mut [f64]) {
    let (a, w, p0) = (pars[0], pars[1], pars[2]);
    let y0 = if pars.len() > 3 { pars[3] } else { 0.0 };
    let th = if pars.len() > 4 { pars[4] } else { 0.0 };
    let gam = w / 2.0;
    let k = (2.0 / std::f64::consts::PI).sqrt();
    let y: Vec<C> = ppm.iter().map(|&x| C::new(gam, -(x - p0)) * k / (gam * gam + (x - p0) * (x - p0))).collect();
    let mx = y.iter().map(|z| z.norm()).fold(f64::NEG_INFINITY, f64::max);
    let z = phasor_deg(th);
    for (o, v) in out.iter_mut().zip(&y) {
        *o = ((v / mx * a + y0) * z).re;
    }
}

/// op_getLW: full width at half maximum (Hz) of the peak between
/// `ref_min` and `ref_max` ppm (defaults 4.4-5.0, water) after zero-filling
/// by `zp_factor` (8): the mean of the width measured at half height and the
/// width of a Lorentzian fit (nlinfit, default options).
pub fn op_get_lw(input: &Spectra, ref_min: f64, ref_max: f64, zp_factor: f64) -> Result<f64, String> {
    let zp = op_zeropad(input, zp_factor);
    let s = spec(&zp.fids[..zp.n()]);
    let idx: Vec<usize> = (0..s.len()).filter(|&i| zp.ppm[i] > ref_min && zp.ppm[i] < ref_max).collect();
    if idx.len() < 5 {
        return Err(format!("Too few spectral points between {ref_min} and {ref_max} ppm."));
    }
    let win: Vec<f64> = idx.iter().map(|&i| s[i].re).collect();
    let ppmw: Vec<f64> = idx.iter().map(|&i| zp.ppm[i]).collect();
    let mabs = win.iter().map(|v| v.abs()).fold(f64::NEG_INFINITY, f64::max);
    let imax = (0..win.len()).find(|&i| win[i].abs() == mabs).unwrap();
    let max_ref = win[imax];
    let gt: Vec<usize> = (0..win.len()).filter(|&i| win[i].abs() >= 0.5 * max_ref.abs()).collect();
    let fwhm1 = (ppmw[gt[0]] - ppmw[gt[gt.len() - 1]]) * 42.577 * zp.bo;
    let guess = [max_ref, (5.0 * zp.bo / 3.0) / (42.577 * zp.bo), ppmw[imax], 0.0, 0.0];
    let mut model = |p: &[f64], out: &mut [f64]| op_lorentz(p, &ppmw, out);
    let fit = nlinfit(&win, &mut model, &guess, &NlinOpts::default(), None);
    let fwhm2 = fit.beta[1].abs() * 42.577 * zp.bo;
    Ok((fwhm1 + fwhm2) / 2.0)
}

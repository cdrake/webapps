//! HSVD: op_removeWater and op_HSVDfit.
//!
//! FID-A builds the Hankel matrix of the conjugated FID, takes the leading
//! `K` left singular vectors with a full `svd`, and fits damped complex
//! exponentials to the signal-pole estimates (Barkhuijsen et al. 1987). The
//! poles depend only on the span of those vectors, which this computes from
//! the Gram matrix `H'H` (see `linalg::hankel_left_subspace`) instead of an
//! SVD of the full `0.75N x 0.25N` matrix. FID-A's model structures hold
//! `fids` as the conjugated row it fits; here `model.fids` is the FID whose
//! spectrum is FID-A's `model.specs`.

use num_complex::Complex64 as C;

use super::linalg::{eigvals, hankel_left_subspace, lstsq, CMat};
use super::util::spec;
use crate::spectra::Spectra;

/// FID-A `out.watersupp`.
#[derive(Clone, Debug, Default)]
pub struct HsvdComponents {
    /// Damping (1/s) of the selected components.
    pub damp: Vec<f64>,
    /// Angular frequency (rad/s) of the selected components.
    pub freq: Vec<f64>,
    pub phase: Vec<f64>,
    pub amp: Vec<f64>,
    pub ppm: Vec<f64>,
    pub ppm_all: Vec<f64>,
    pub damp_all: Vec<f64>,
    pub k: usize,
    pub residual_error: f64,
}

/// Output of op_removeWater / op_HSVDfit.
#[derive(Clone, Debug)]
pub struct Hsvd {
    /// op_removeWater: water removed. op_HSVDfit: the residual.
    pub out: Spectra,
    /// The selected components as a structure.
    pub model: Spectra,
    pub components: HsvdComponents,
}

struct Poles {
    k: usize,
    w: Vec<f64>,
    alpha: Vec<f64>,
    amp: Vec<f64>,
    ph: Vec<f64>,
}

/// op_removeWater: remove the HSVD components between `wlim` ppm (default
/// [4.4, 5]) with `kinit` components (30) and Hankel rows `m`
/// (`floor(0.75 N)`).
pub fn op_remove_water(input: &Spectra, wlim: [f64; 2], kinit: usize, m: Option<usize>) -> Result<Hsvd, String> {
    hsvd(input, wlim, kinit, m, true)
}

/// op_HSVDfit: model the HSVD components between `ppmlim` (default
/// [0.2, 4.2]); `out` is the residual.
pub fn op_hsvd_fit(input: &Spectra, ppmlim: [f64; 2], kinit: usize, m: Option<usize>) -> Result<Hsvd, String> {
    hsvd(input, ppmlim, kinit, m, false)
}

fn hsvd(input: &Spectra, lim: [f64; 2], kinit: usize, m: Option<usize>, water: bool) -> Result<Hsvd, String> {
    if input.n_fids() != 1 {
        return Err("HSVD works on a single spectrum; average and combine the data first.".into());
    }
    let n = input.n();
    let m = m.unwrap_or((n as f64 * 0.75).floor() as usize);
    if m < 2 || m >= n {
        return Err(format!("HSVD needs 2 <= M < N (M = {m}, N = {n})."));
    }
    let dt = input.dwelltime;
    let t = &input.t[..n];
    // fid = in.fids(1:N)'  (conjugated)
    let fid: Vec<C> = input.fids[..n].iter().map(|z| z.conj()).collect();
    let kmax = kinit.min(n - m + 1).min(m - 1);
    let u = hankel_left_subspace(&fid, m, kmax);
    let mut count = 0;
    let poles = loop {
        let k = kinit.saturating_sub(count).min(kmax);
        let p = poles_for(&u, k, dt, t, input)?;
        count += 1;
        let bad = p.amp.iter().any(|&a| a == 0.0 || a.is_nan());
        if !bad || k < 2 {
            break p;
        }
    };
    // Model spectrum of all components (data domain) for the residual error.
    let comp = |sel: &[usize]| -> Vec<C> {
        (0..n)
            .map(|j| {
                sel.iter()
                    .map(|&c| C::from_polar(poles.amp[c], poles.ph[c]) * C::new(-poles.alpha[c], -poles.w[c]).scale(t[j]).exp())
                    .sum()
            })
            .collect()
    };
    let all: Vec<usize> = (0..poles.k).collect();
    let spec_in = spec(&input.fids[..n]);
    let spec_model = spec(&comp(&all));
    let er = spec_in.iter().zip(&spec_model).map(|(a, b)| (a - b).norm_sqr()).sum::<f64>() / n as f64;
    let freqs: Vec<f64> = poles.w.iter().map(|w| w / (2.0 * std::f64::consts::PI)).collect();
    let ppms: Vec<f64> = freqs.iter().map(|f| -f / (input.txfrq / 1e6) + 4.65).collect();
    let sel: Vec<usize> = (0..poles.k).filter(|&c| ppms[c] > lim[0] && ppms[c] < lim[1]).collect();
    let sel_fid = comp(&sel);
    let mut out = input.clone();
    out.fids = input.fids[..n].iter().zip(&sel_fid).map(|(a, b)| a - b).collect();
    out.sz = vec![n, 1];
    let mut model = input.clone();
    model.fids = sel_fid;
    model.sz = vec![n, 1];
    let _ = water;
    let components = HsvdComponents {
        damp: sel.iter().map(|&c| poles.alpha[c]).collect(),
        freq: sel.iter().map(|&c| poles.w[c]).collect(),
        phase: sel.iter().map(|&c| poles.ph[c]).collect(),
        amp: sel.iter().map(|&c| poles.amp[c]).collect(),
        ppm: sel.iter().map(|&c| ppms[c]).collect(),
        ppm_all: ppms,
        damp_all: poles.alpha.clone(),
        k: poles.k,
        residual_error: er,
    };
    Ok(Hsvd { out, model, components })
}

fn poles_for(u: &CMat, k: usize, dt: f64, t: &[f64], input: &Spectra) -> Result<Poles, String> {
    let rows = u.rows;
    // Utk = Uk(2:end,:), Ubk = Uk(1:end-1,:); Eh = Utk \ Ubk; eig(Eh').
    let mut utk = CMat::zeros(rows - 1, k);
    let mut ubk = CMat::zeros(rows - 1, k);
    for c in 0..k {
        for r in 0..rows - 1 {
            utk[(r, c)] = u[(r + 1, c)];
            ubk[(r, c)] = u[(r, c)];
        }
    }
    let eh = lstsq(&utk, &ubk);
    let z = eigvals(&eh.h());
    let w: Vec<f64> = z.iter().map(|v| v.im.atan2(v.re) / dt).collect();
    let alpha: Vec<f64> = z.iter().map(|v| (v.norm() - 1.0) / dt).collect();
    // phamp = fid_temp' \ fid' with fid_temp = exp((-alpha + 1i*w)*t).
    let n = t.len();
    let mut a = CMat::zeros(n, k);
    for c in 0..k {
        for j in 0..n {
            a[(j, c)] = C::new(-alpha[c], w[c]).scale(t[j]).exp().conj();
        }
    }
    let b = CMat::from_col(&input.fids[..n]);
    let phamp = lstsq(&a, &b);
    let amp = phamp.col_slice(0).iter().map(|v| v.norm()).collect();
    let ph = phamp.col_slice(0).iter().map(|v| v.im.atan2(v.re)).collect();
    Ok(Poles { k, w, alpha, amp, ph })
}

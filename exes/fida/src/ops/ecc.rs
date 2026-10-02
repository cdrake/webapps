//! Eddy-current correction (Klose 1990): op_ecc_klose.
//!
//! FID-A's `op_ecc` is interactive (it asks for a time window) and fits a
//! 150-piece spline (`splinefit`) to the water phase; `op_ecc_klose` is the
//! plain Klose method it is based on, which this ports: subtract the
//! unwrapped phase of the water FID point by point from both the metabolite
//! and water data, then add back the phase of the first point.

use num_complex::Complex64 as C;

use super::basic::op_addphase;
use super::util::phase;
use crate::spectra::Spectra;

/// op_ecc_klose: returns (corrected metabolite, corrected water).
pub fn op_ecc(input: &Spectra, inw: &Spectra) -> Result<(Spectra, Spectra), String> {
    if inw.dims.coils != 0 || inw.dims.averages != 0 || inw.dims.sub_specs != 0 {
        return Err("Combine receivers, averages and subspectra of the water reference before eddy-current correction.".into());
    }
    let n = input.n();
    if inw.n() != n {
        return Err(format!("The water reference has {} points; the data have {n}.", inw.n()));
    }
    let ec = phase(&inw.fids[..n]);
    let rot: Vec<C> = ec.iter().map(|p| C::new(0.0, -p).exp()).collect();
    let mut out = input.clone();
    for k in 0..input.n_fids() {
        for (v, r) in out.fids[k * n..(k + 1) * n].iter_mut().zip(&rot) {
            *v *= r;
        }
    }
    let ph0 = 180.0 * ec[0] / std::f64::consts::PI;
    let out = op_addphase(&out, ph0, 0.0, 4.65);
    let mut outw = inw.clone();
    for (v, r) in outw.fids.iter_mut().zip(&rot) {
        *v *= r;
    }
    let outw = op_addphase(&outw, ph0, 0.0, 4.65);
    Ok((out, outw))
}

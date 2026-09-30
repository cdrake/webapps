//! Averages: op_averaging, op_median, op_rmbadaverages, op_rmworstaverage,
//! op_takeaverages.

use num_complex::Complex64 as C;

use super::basic::op_filter;
use super::util::{dims_without, mean, median, polyfit, polyval, reduce_axis, select_axis, spec, squeeze, std, sum_axis, with_axis};
use crate::spectra::Spectra;

fn collapse(input: &Spectra, axis1: usize, fids: Vec<C>) -> Spectra {
    let mut out = input.clone();
    out.fids = fids;
    out.sz = squeeze(&with_axis(&input.sz, axis1 - 1, 1));
    out.dims = dims_without(input.dims, axis1);
    out
}

/// op_averaging: mean over the averages dimension. Returns the input
/// unchanged (FID-A prints a warning) when there is nothing to average.
pub fn op_averaging(input: &Spectra) -> Spectra {
    if input.flags.averaged || input.averages < 2 || input.dims.averages == 0 {
        return input.clone();
    }
    let a = input.dims.averages;
    let na = input.size(a) as f64;
    let mut fids = sum_axis(&input.fids, &input.sz, a - 1);
    for v in fids.iter_mut() {
        *v /= na;
    }
    let mut out = collapse(input, a, fids);
    out.averages = 1;
    out.flags.writtentostruct = true;
    out.flags.averaged = true;
    out
}

/// op_median: median over the averages, real and imaginary parts separately.
pub fn op_median(input: &Spectra) -> Spectra {
    if input.flags.averaged || input.dims.averages == 0 || input.averages < 2 {
        return input.clone();
    }
    let a = input.dims.averages;
    let mut re = Vec::new();
    let mut im = Vec::new();
    let fids = reduce_axis(&input.fids, &input.sz, a - 1, |line| {
        re.clear();
        im.clear();
        re.extend(line.iter().map(|z| z.re));
        im.extend(line.iter().map(|z| z.im));
        C::new(median(&re), median(&im))
    });
    let mut out = collapse(input, a, fids);
    out.averages = 1;
    out.flags.writtentostruct = true;
    out.flags.averaged = true;
    out
}

/// Element (time point `i`, average `n`, subspectrum `m`) with FID-A's
/// `fids(i,n,m)` indexing (averages in dimension 2, subspectra in 3).
fn at3(s: &Spectra, i: usize, n: usize, m: usize) -> C {
    let nt = s.n();
    let na = s.size(2);
    s.fids[i + nt * (n + na * m)]
}

/// Which domain op_rmbadaverages compares averages in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Time,
    Freq,
}

/// Result of op_rmbadaverages / op_rmworstaverage.
#[derive(Clone, Debug)]
pub struct RmBad {
    pub out: Spectra,
    /// Deviation metric per average (rows) and subspectrum (columns), column-major.
    pub metric: Vec<f64>,
    pub n_subspecs: usize,
    /// Removed averages, 0-based, ascending.
    pub bad: Vec<usize>,
}

/// op_rmbadaverages: remove averages whose squared deviation from the median
/// (first 0.4 s of the real FID for `Time`; real spectrum after 10 Hz
/// broadening for `Freq`) exceeds a quadratic trend of its z-score by `nsd`.
///
/// FID-A's frequency-domain branch never defines `tmax` and so fails
/// (MATLAB and Octave both stop with "'tmax' undefined"); `Freq` here uses
/// the spectrum as that branch intends, with no time window.
pub fn op_rmbadaverages(input: &Spectra, nsd: f64, domain: Domain) -> Result<RmBad, String> {
    if input.flags.averaged {
        return Err("Averaging has already been performed; bad averages can no longer be removed.".into());
    }
    if !input.flags.addedrcvrs {
        return Err("Combine the receiver channels before removing bad averages.".into());
    }
    if input.dims.averages != 2 {
        return Err("op_rmbadaverages expects the averages in the second dimension.".into());
    }
    let ss = if input.dims.sub_specs > 0 { input.size(input.dims.sub_specs) } else { 1 };
    let na = input.size(2);
    let nt = input.n();
    let infilt = match domain {
        Domain::Time => input.clone(),
        Domain::Freq => op_filter(input, 10.0),
    };
    let inavg = op_median(&infilt);
    let mut metric = vec![0.0; na * ss];
    match domain {
        Domain::Time => {
            let tr: Vec<usize> = (0..nt).filter(|&i| infilt.t[i] >= 0.0 && infilt.t[i] <= 0.4).collect();
            for m in 0..ss {
                for n in 0..na {
                    let mut s = 0.0;
                    for &i in &tr {
                        let d = at3(&infilt, i, n, m).re - inavg.fids[i + nt * m].re;
                        s += d * d;
                    }
                    metric[n + na * m] = s;
                }
            }
        }
        Domain::Freq => {
            for m in 0..ss {
                let base = spec(&inavg.fids[nt * m..nt * (m + 1)]);
                for n in 0..na {
                    let k = n + na * m;
                    let sp = spec(&infilt.fids[nt * k..nt * (k + 1)]);
                    metric[k] = sp.iter().zip(&base).map(|(a, b)| (a.re - b.re) * (a.re - b.re)).sum();
                }
            }
        }
    }
    let x: Vec<f64> = (1..=na).map(|v| v as f64).collect();
    let mut mask = vec![false; na];
    for m in 0..ss {
        let col = &metric[na * m..na * (m + 1)];
        let (avg, sd) = (mean(col), std(col));
        let z: Vec<f64> = col.iter().map(|v| (v - avg) / sd).collect();
        let p = polyfit(&x, &z, 2);
        for n in 0..na {
            if z[n] > polyval(&p, x[n]) + nsd {
                mask[n] = true;
            }
        }
    }
    Ok(remove(input, metric, ss, mask))
}

fn remove(input: &Spectra, metric: Vec<f64>, ss: usize, mask: Vec<bool>) -> RmBad {
    let bad: Vec<usize> = (0..mask.len()).filter(|&n| mask[n]).collect();
    let good: Vec<usize> = (0..mask.len()).filter(|&n| !mask[n]).collect();
    let mut out = input.clone();
    out.fids = select_axis(&input.fids, &input.sz, 1, &good);
    out.sz = with_axis(&input.sz, 1, good.len());
    out.averages = good.len() * input.raw_subspecs;
    out.flags.writtentostruct = true;
    RmBad { out, metric, n_subspecs: ss, bad }
}

/// op_rmworstaverage: remove the average whose frequency-domain metric (10 Hz
/// broadening) lies furthest above its quadratic trend. FID-A divides by the
/// row of standard deviations with `/`, which fails with subspectra; this
/// does too.
pub fn op_rmworstaverage(input: &Spectra) -> Result<RmBad, String> {
    if input.flags.averaged {
        return Err("Averaging has already been performed.".into());
    }
    if !input.flags.addedrcvrs {
        return Err("Combine the receiver channels first.".into());
    }
    if input.dims.averages != 2 {
        return Err("op_rmworstaverage expects the averages in the second dimension.".into());
    }
    let ss = if input.dims.sub_specs > 0 { input.size(input.dims.sub_specs) } else { 1 };
    if ss > 1 {
        return Err("FID-A's op_rmworstaverage cannot handle subspectra (its z-score uses a matrix division).".into());
    }
    let na = input.size(2);
    let nt = input.n();
    let infilt = op_filter(input, 10.0);
    let inavg = op_median(&infilt);
    let base = spec(&inavg.fids[..nt]);
    let metric: Vec<f64> = (0..na)
        .map(|n| {
            let sp = spec(&infilt.fids[nt * n..nt * (n + 1)]);
            sp.iter().zip(&base).map(|(a, b)| (a.re - b.re) * (a.re - b.re)).sum()
        })
        .collect();
    let (avg, sd) = (mean(&metric), std(&metric));
    let z: Vec<f64> = metric.iter().map(|v| (v - avg) / sd).collect();
    let x: Vec<f64> = (1..=na).map(|v| v as f64).collect();
    let p = polyfit(&x, &z, 2);
    let dev: Vec<f64> = (0..na).map(|n| z[n] - polyval(&p, x[n])).collect();
    let mx = dev.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mask: Vec<bool> = dev.iter().map(|&d| d == mx).collect();
    Ok(remove(input, metric, 1, mask))
}

/// op_takeaverages: keep the averages `index` (0-based).
pub fn op_takeaverages(input: &Spectra, index: &[usize]) -> Result<Spectra, String> {
    let a = input.dims.averages;
    if a == 0 {
        return Err("There are no averages in this dataset.".into());
    }
    if a == 1 {
        return Err("dims.averages == 1; this should never happen.".into());
    }
    if index.iter().any(|&i| i >= input.size(a)) {
        return Err("Average index out of range.".into());
    }
    let fids = select_axis(&input.fids, &input.sz, a - 1, index);
    let mut out = input.clone();
    out.fids = fids;
    out.sz = squeeze(&with_axis(&input.sz, a - 1, index.len()));
    if index.len() == 1 {
        let d = dims_without(input.dims, a);
        out.dims = crate::spectra::Dims { t: input.dims.t, ..d };
    }
    out.averages = if out.dims.averages == 0 { 1 } else { out.size(out.dims.averages) };
    out.raw_averages = out.averages;
    out.flags.writtentostruct = true;
    if index.len() == 1 {
        out.flags.averaged = true;
    }
    Ok(out)
}

//! `nlinfit`: Levenberg-Marquardt nonlinear least squares, as FID-A's
//! alignment and linewidth functions call it.
//!
//! This is the algorithm MATLAB's `nlinfit` documents, and exactly the one
//! `validation/octave-shims/nlinfit.m` runs in Octave for the reference
//! results:
//!
//! * forward-difference Jacobian with step `DerivStep*beta(j)`
//!   (`DerivStep*norm(beta)`, or `DerivStep` when all of beta is 0, for a
//!   zero coefficient), `DerivStep = eps^(1/3)`;
//! * LM step `[J; diag(sqrt(lambda*sum(J.^2)))] \ [r; 0]`, `lambda` starting
//!   at 0.01, divided by 10 after a step that lowers the SSE (never below
//!   eps) and multiplied by 10 until the SSE does not rise (giving up above
//!   1e16);
//! * stop when `norm(step) < TolX*(sqrt(eps)+norm(beta))`, when
//!   `|sse-sseold| <= TolFun*sse`, or after `MaxIter` iterations.
//!
//! Octave has no `nlinfit` of its own in the statistics package (1.8.2);
//! the optim package's `nlinfit` wraps a different, SVD-based LM
//! (`__lm_svd__`, GPL). It converges to the same minimum within `TolX` on
//! these well-conditioned two-parameter problems but takes different steps;
//! it was not ported (licence) and is not installed here. MATLAB's own
//! `nlinfit` additionally supports robust weights, error models and
//! `FunValCheck`, none of which FID-A uses.

use crate::ops::linalg::lstsq_real;

/// `statset('nlinfit')` fields FID-A sets.
#[derive(Clone, Copy, Debug)]
pub struct NlinOpts {
    pub max_iter: usize,
    pub tol_x: f64,
    pub tol_fun: f64,
    pub deriv_step: f64,
}

impl Default for NlinOpts {
    /// `statset('nlinfit')`: MaxIter 100, TolX 1e-8, TolFun 1e-8.
    fn default() -> Self {
        NlinOpts { max_iter: 100, tol_x: 1e-8, tol_fun: 1e-8, deriv_step: f64::EPSILON.powf(1.0 / 3.0) }
    }
}

impl NlinOpts {
    /// `statset(nlinopts,'MaxIter',400,'TolX',1e-8,'TolFun',1e-8)` used by
    /// op_alignAverages, op_alignAverages_fd and op_alignMPSubspecs.
    pub fn fida_align() -> Self {
        NlinOpts { max_iter: 400, ..Default::default() }
    }
}

/// Result of a fit.
#[derive(Clone, Debug)]
pub struct NlinFit {
    pub beta: Vec<f64>,
    pub iterations: usize,
    pub sse: f64,
}

/// Fit `model(beta) ~ y` (the model closes over the predictors). `weights`
/// are the `'Weights'` name/value option (residuals scaled by `sqrt(w)`).
pub fn nlinfit(y: &[f64], model: &mut dyn FnMut(&[f64], &mut [f64]), beta0: &[f64], opts: &NlinOpts, weights: Option<&[f64]>) -> NlinFit {
    let m = y.len();
    let p = beta0.len();
    let sw: Vec<f64> = match weights {
        Some(w) => w.iter().map(|v| v.sqrt()).collect(),
        None => vec![1.0; m],
    };
    let sqrteps = f64::EPSILON.sqrt();
    let mut beta = beta0.to_vec();
    let mut yfit = vec![0.0; m];
    let mut yplus = vec![0.0; m];
    let mut r = vec![0.0; m];
    let resid = |yfit: &[f64], r: &mut [f64]| -> f64 {
        let mut sse = 0.0;
        for i in 0..m {
            r[i] = sw[i] * (y[i] - yfit[i]);
            sse += r[i] * r[i];
        }
        sse
    };
    model(&beta, &mut yfit);
    let mut sse = resid(&yfit, &mut r);
    let mut lambda = 0.01;
    let mut iter = 0;
    let mut jac = vec![0.0; (m + p) * p];
    let mut rplus = vec![0.0; m + p];
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    while iter < opts.max_iter {
        iter += 1;
        let betaold = beta.clone();
        let sseold = sse;
        // Forward-difference Jacobian into the top m rows of the augmented matrix.
        let mut diag = vec![0.0; p];
        for j in 0..p {
            let mut bnew = beta.clone();
            let delta = if beta[j] == 0.0 {
                let nb = norm(&beta);
                opts.deriv_step * (nb + if nb == 0.0 { 1.0 } else { 0.0 })
            } else {
                opts.deriv_step * beta[j]
            };
            bnew[j] += delta;
            model(&bnew, &mut yplus);
            let col = &mut jac[j * (m + p)..(j + 1) * (m + p)];
            let mut s = 0.0;
            for i in 0..m {
                let v = sw[i] * (yplus[i] - yfit[i]) / delta;
                col[i] = v;
                s += v * v;
            }
            diag[j] = s;
        }
        rplus[..m].copy_from_slice(&r);
        for v in rplus[m..].iter_mut() {
            *v = 0.0;
        }
        let solve = |lambda: f64, jac: &mut [f64]| -> Vec<f64> {
            for j in 0..p {
                let col = &mut jac[j * (m + p)..(j + 1) * (m + p)];
                for k in 0..p {
                    col[m + k] = if k == j { (lambda * diag[j]).sqrt() } else { 0.0 };
                }
            }
            lstsq_real(jac, m + p, p, &rplus)
        };
        let mut step = solve(lambda, &mut jac);
        for j in 0..p {
            beta[j] = betaold[j] + step[j];
        }
        model(&beta, &mut yfit);
        sse = resid(&yfit, &mut r);
        let mut break_out = false;
        if sse < sseold {
            lambda = (0.1 * lambda).max(f64::EPSILON);
        } else {
            while sse > sseold {
                lambda *= 10.0;
                if lambda > 1e16 {
                    break_out = true;
                    break;
                }
                step = solve(lambda, &mut jac);
                for j in 0..p {
                    beta[j] = betaold[j] + step[j];
                }
                model(&beta, &mut yfit);
                sse = resid(&yfit, &mut r);
            }
        }
        if norm(&step) < opts.tol_x * (sqrteps + norm(&beta)) {
            break;
        } else if (sse - sseold).abs() <= opts.tol_fun * sse {
            break;
        } else if break_out {
            break;
        }
    }
    NlinFit { beta, iterations: iter, sse }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_decay() {
        let x: Vec<f64> = (0..51).map(|k| k as f64 * 0.1).collect();
        let truth = [1.0, 3.0, 2.0];
        let y: Vec<f64> = x.iter().map(|&t| truth[0] + truth[1] * (-truth[2] * t).exp()).collect();
        let mut model = |b: &[f64], out: &mut [f64]| {
            for (o, &t) in out.iter_mut().zip(&x) {
                *o = b[0] + b[1] * (-b[2] * t).exp();
            }
        };
        let fit = nlinfit(&y, &mut model, &[2.0, 2.0, 3.0], &NlinOpts::fida_align(), None);
        for (b, t) in fit.beta.iter().zip(truth) {
            assert!((b - t).abs() < 1e-7, "{:?}", fit.beta);
        }
    }
}

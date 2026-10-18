//! The sparse step of AMICO's NODDI fit: SPAMS `lasso(mode=2, pos=True)`, which minimises
//! ½‖y − D x‖² + λ1‖x‖₁ + ½λ2‖x‖² subject to x ≥ 0. With λ2 > 0 the problem is strictly
//! convex, so its minimiser is unique and any exact solver finds the same support. This one runs
//! cyclic coordinate descent on the Gram matrix until the support stops changing, then solves
//! the optimality conditions on that support exactly and checks them for every coefficient. Only
//! when the check fails does it go on with descent.

/// `d` is column-major m×n. Returns x (n values).
pub fn lasso_nonneg(
    d: &[f64],
    m: usize,
    n: usize,
    y: &[f64],
    lambda1: f64,
    lambda2: f64,
) -> Vec<f64> {
    assert_eq!(d.len(), m * n);
    assert_eq!(y.len(), m);
    let col = |j: usize| &d[j * m..(j + 1) * m];
    let mut gram = vec![0.0f64; n * n];
    let mut corr = vec![0.0f64; n];
    for j in 0..n {
        corr[j] = col(j).iter().zip(y).map(|(a, b)| a * b).sum();
        for k in 0..=j {
            let g: f64 = col(j).iter().zip(col(k)).map(|(a, b)| a * b).sum();
            gram[j * n + k] = g;
            gram[k * n + j] = g;
        }
    }
    let mut x = vec![0.0f64; n];
    // dx[j] = (Dᵀ D x)_j, kept up to date.
    let mut dx = vec![0.0f64; n];
    let mut tried: Vec<usize> = Vec::new();
    for _ in 0..100_000 {
        let support: Vec<usize> = (0..n).filter(|&j| x[j] > 0.0).collect();
        if !support.is_empty() && support != tried {
            if let Some(exact) = solve_on_support(&gram, &corr, n, &support, lambda1, lambda2) {
                return exact;
            }
            tried = support;
        }
        let mut largest = 0.0f64;
        for j in 0..n {
            let diag = gram[j * n + j] + lambda2;
            if diag <= 0.0 {
                continue;
            }
            let rest = dx[j] - gram[j * n + j] * x[j];
            let value = ((corr[j] - rest - lambda1) / diag).max(0.0);
            let step = value - x[j];
            if step != 0.0 {
                for k in 0..n {
                    dx[k] += gram[k * n + j] * step;
                }
                x[j] = value;
                largest = largest.max(step.abs() / value.abs().max(1e-300));
            }
        }
        if largest < 1e-13 {
            break;
        }
    }
    x
}

/// Solves (G_SS + λ2 I) x_S = c_S − λ1 on support S and returns the full x when the optimality
/// conditions hold: x_S > 0, and c_j − (G x)_j − λ1 ≤ 0 off the support.
fn solve_on_support(
    gram: &[f64],
    corr: &[f64],
    n: usize,
    support: &[usize],
    lambda1: f64,
    lambda2: f64,
) -> Option<Vec<f64>> {
    let k = support.len();
    let mut a = vec![0.0f64; k * k];
    let mut b: Vec<f64> = support.iter().map(|&j| corr[j] - lambda1).collect();
    for (p, &j) in support.iter().enumerate() {
        for (q, &i) in support.iter().enumerate() {
            a[p * k + q] = gram[j * n + i] + if p == q { lambda2 } else { 0.0 };
        }
    }
    // Cholesky, lower triangle in place.
    for j in 0..k {
        let mut d = a[j * k + j];
        for t in 0..j {
            d -= a[j * k + t] * a[j * k + t];
        }
        if d <= 0.0 {
            return None;
        }
        let d = d.sqrt();
        a[j * k + j] = d;
        for i in j + 1..k {
            let mut s = a[i * k + j];
            for t in 0..j {
                s -= a[i * k + t] * a[j * k + t];
            }
            a[i * k + j] = s / d;
        }
    }
    for i in 0..k {
        for t in 0..i {
            b[i] -= a[i * k + t] * b[t];
        }
        b[i] /= a[i * k + i];
    }
    for i in (0..k).rev() {
        for t in i + 1..k {
            b[i] -= a[t * k + i] * b[t];
        }
        b[i] /= a[i * k + i];
    }
    if b.iter().any(|&v| v <= 0.0) {
        return None;
    }
    let mut x = vec![0.0f64; n];
    for (p, &j) in support.iter().enumerate() {
        x[j] = b[p];
    }
    let scale = corr.iter().fold(lambda1, |m, c| m.max(c.abs()));
    for j in 0..n {
        if x[j] > 0.0 {
            continue;
        }
        let g: f64 = support.iter().map(|&i| gram[j * n + i] * x[i]).sum();
        if corr[j] - g - lambda1 > 1e-12 * scale {
            return None;
        }
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orthonormal_design_soft_thresholds() {
        // With DᵀD = I, x_j = max(0, (dᵀy)_j − λ1) / (1 + λ2).
        let d = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let y = [2.0, 0.3, 5.0];
        let x = lasso_nonneg(&d, 3, 2, &y, 0.5, 0.001);
        assert!((x[0] - 1.5 / 1.001).abs() < 1e-14);
        assert_eq!(x[1], 0.0);
    }

    #[test]
    fn negative_correlation_stays_at_zero() {
        let d = [1.0, 1.0];
        let x = lasso_nonneg(&d, 2, 1, &[-1.0, -2.0], 0.0, 0.0);
        assert_eq!(x[0], 0.0);
    }
}

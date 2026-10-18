//! Special functions for the NODDI kernels: erf (libm, a port of the musl/FreeBSD erf),
//! the imaginary error function and Legendre polynomials.

pub use libm::erf;

/// erfi(x) = 2/√π Σ x^(2n+1) / (n! (2n+1)). Every term is positive, so the series has no
/// cancellation; AMICO's kappa ≤ 21.3 (OD ≥ 0.03) needs about 60 terms.
pub fn erfi(x: f64) -> f64 {
    let x2 = x * x;
    let mut power = x;
    let mut sum = x;
    let mut n = 0.0f64;
    loop {
        n += 1.0;
        power *= x2 / n;
        let term = power / (2.0 * n + 1.0);
        sum += term;
        if term <= sum * 1e-17 {
            break;
        }
    }
    sum * 2.0 / std::f64::consts::PI.sqrt()
}

/// The Legendre polynomial P_l(x) by Bonnet's recurrence (scipy.special.lpmv(0, l, x)).
pub fn legendre(l: usize, x: f64) -> f64 {
    if l == 0 {
        return 1.0;
    }
    let mut p0 = 1.0;
    let mut p1 = x;
    for k in 1..l {
        let k = k as f64;
        let p2 = ((2.0 * k + 1.0) * x * p1 - k * p0) / (k + 1.0);
        p0 = p1;
        p1 = p2;
    }
    p1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erfi_matches_scipy() {
        // scipy.special.erfi at these points.
        let cases = [
            (0.1, 0.11321517416959982),
            (1.0, 1.6504257587975428),
            (3.0, 1629.9946226015657),
            (4.6, 194667358.4700882),
        ];
        for (x, want) in cases {
            let got = erfi(x);
            assert!(
                ((got - want) / want).abs() < 1e-13,
                "erfi({x}) = {got}, want {want}"
            );
        }
    }

    #[test]
    fn legendre_matches_closed_forms() {
        let x: f64 = 0.37;
        assert!((legendre(2, x) - (3.0 * x * x - 1.0) / 2.0).abs() < 1e-15);
        let p4 = (35.0 * x.powi(4) - 30.0 * x * x + 3.0) / 8.0;
        assert!((legendre(4, x) - p4).abs() < 1e-15);
        assert_eq!(legendre(12, 1.0), 1.0);
    }
}

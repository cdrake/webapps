//! The dense complex linear algebra FID-A gets from MATLAB builtins:
//! `\` (least squares by Householder QR), `eig` of a small general matrix,
//! and the leading singular subspace of a Hankel matrix (`svd` in HSVD).

use num_complex::Complex64 as C;
use std::ops::{Index, IndexMut};

const Z: C = C { re: 0.0, im: 0.0 };

/// A column-major complex matrix.
#[derive(Clone, Debug)]
pub struct CMat {
    pub rows: usize,
    pub cols: usize,
    pub data: Vec<C>,
}

impl CMat {
    pub fn zeros(rows: usize, cols: usize) -> Self {
        CMat { rows, cols, data: vec![Z; rows * cols] }
    }

    pub fn from_col(x: &[C]) -> Self {
        CMat { rows: x.len(), cols: 1, data: x.to_vec() }
    }

    pub fn col(&self, j: usize) -> Vec<C> {
        self.data[j * self.rows..(j + 1) * self.rows].to_vec()
    }

    pub fn col_slice(&self, j: usize) -> &[C] {
        &self.data[j * self.rows..(j + 1) * self.rows]
    }

    /// Conjugate transpose.
    pub fn h(&self) -> CMat {
        let mut o = CMat::zeros(self.cols, self.rows);
        for j in 0..self.cols {
            for i in 0..self.rows {
                o[(j, i)] = self[(i, j)].conj();
            }
        }
        o
    }

    pub fn mul(&self, b: &CMat) -> CMat {
        assert_eq!(self.cols, b.rows);
        let mut o = CMat::zeros(self.rows, b.cols);
        for j in 0..b.cols {
            for k in 0..self.cols {
                let bk = b[(k, j)];
                if bk == Z {
                    continue;
                }
                let a = &self.data[k * self.rows..(k + 1) * self.rows];
                let oc = &mut o.data[j * self.rows..(j + 1) * self.rows];
                for (x, y) in oc.iter_mut().zip(a) {
                    *x += y * bk;
                }
            }
        }
        o
    }
}

impl Index<(usize, usize)> for CMat {
    type Output = C;
    fn index(&self, (i, j): (usize, usize)) -> &C {
        &self.data[i + j * self.rows]
    }
}

impl IndexMut<(usize, usize)> for CMat {
    fn index_mut(&mut self, (i, j): (usize, usize)) -> &mut C {
        &mut self.data[i + j * self.rows]
    }
}

/// `a \ b` for `a` with at least as many rows as columns: the least squares
/// solution from a Householder QR factorisation (MATLAB's method for a
/// full-rank rectangular system; for a square one it uses LU, which agrees to
/// rounding).
pub fn lstsq(a: &CMat, b: &CMat) -> CMat {
    let (m, n) = (a.rows, a.cols);
    assert!(m >= n, "lstsq needs rows >= cols");
    assert_eq!(b.rows, m);
    let mut r = a.clone();
    let mut y = b.clone();
    for k in 0..n {
        // Householder vector for column k, rows k..m.
        let mut norm = 0.0;
        for i in k..m {
            norm += r[(i, k)].norm_sqr();
        }
        let norm = norm.sqrt();
        if norm == 0.0 {
            continue;
        }
        let x0 = r[(k, k)];
        let ph = if x0.norm() == 0.0 { C::new(1.0, 0.0) } else { x0 / x0.norm() };
        let alpha = -ph * norm;
        let mut v: Vec<C> = (k..m).map(|i| r[(i, k)]).collect();
        v[0] -= alpha;
        let vn = v.iter().map(|z| z.norm_sqr()).sum::<f64>().sqrt();
        if vn == 0.0 {
            continue;
        }
        for z in v.iter_mut() {
            *z /= vn;
        }
        // Apply I - 2 v v^H to the remaining columns of r and to y.
        for j in k..n {
            let mut s = Z;
            for (t, i) in (k..m).enumerate() {
                s += v[t].conj() * r[(i, j)];
            }
            s *= 2.0;
            for (t, i) in (k..m).enumerate() {
                let d = v[t] * s;
                r[(i, j)] -= d;
            }
        }
        for j in 0..y.cols {
            let mut s = Z;
            for (t, i) in (k..m).enumerate() {
                s += v[t].conj() * y[(i, j)];
            }
            s *= 2.0;
            for (t, i) in (k..m).enumerate() {
                let d = v[t] * s;
                y[(i, j)] -= d;
            }
        }
    }
    // Back substitution with the n x n upper triangle.
    let mut x = CMat::zeros(n, b.cols);
    for j in 0..b.cols {
        for i in (0..n).rev() {
            let mut s = y[(i, j)];
            for k in i + 1..n {
                s -= r[(i, k)] * x[(k, j)];
            }
            x[(i, j)] = s / r[(i, i)];
        }
    }
    x
}

/// Real least squares `a \ b` (column-major `a`, `m x n`).
pub fn lstsq_real(a: &[f64], m: usize, n: usize, b: &[f64]) -> Vec<f64> {
    let am = CMat { rows: m, cols: n, data: a.iter().map(|&v| C::new(v, 0.0)).collect() };
    let bm = CMat { rows: m, cols: 1, data: b.iter().map(|&v| C::new(v, 0.0)).collect() };
    lstsq(&am, &bm).data.into_iter().map(|c| c.re).collect()
}

/// Eigenvalues of a general complex square matrix (MATLAB `eig(a)`, up to
/// order): Householder reduction to Hessenberg form, then the shifted QR
/// iteration with Wilkinson shifts.
pub fn eigvals(a: &CMat) -> Vec<C> {
    let n = a.rows;
    let mut h = a.clone();
    // Hessenberg reduction.
    for k in 0..n.saturating_sub(2) {
        let mut norm = 0.0;
        for i in k + 1..n {
            norm += h[(i, k)].norm_sqr();
        }
        let norm = norm.sqrt();
        if norm == 0.0 {
            continue;
        }
        let x0 = h[(k + 1, k)];
        let ph = if x0.norm() == 0.0 { C::new(1.0, 0.0) } else { x0 / x0.norm() };
        let alpha = -ph * norm;
        let mut v: Vec<C> = (k + 1..n).map(|i| h[(i, k)]).collect();
        v[0] -= alpha;
        let vn = v.iter().map(|z| z.norm_sqr()).sum::<f64>().sqrt();
        if vn == 0.0 {
            continue;
        }
        for z in v.iter_mut() {
            *z /= vn;
        }
        // H = P H P with P = I - 2 v v^H on rows/cols k+1..n.
        for j in 0..n {
            let mut s = Z;
            for (t, i) in (k + 1..n).enumerate() {
                s += v[t].conj() * h[(i, j)];
            }
            s *= 2.0;
            for (t, i) in (k + 1..n).enumerate() {
                let d = v[t] * s;
                h[(i, j)] -= d;
            }
        }
        for i in 0..n {
            let mut s = Z;
            for (t, j) in (k + 1..n).enumerate() {
                s += h[(i, j)] * v[t];
            }
            s *= 2.0;
            for (t, j) in (k + 1..n).enumerate() {
                let d = s * v[t].conj();
                h[(i, j)] -= d;
            }
        }
        for i in k + 2..n {
            h[(i, k)] = Z;
        }
    }
    let mut ev = vec![Z; n];
    if n == 0 {
        return ev;
    }
    let mut hi = n - 1;
    let mut iter = 0;
    loop {
        if hi == 0 {
            ev[0] = h[(0, 0)];
            break;
        }
        // Deflation point.
        let mut l = hi;
        while l > 0 {
            let s = h[(l - 1, l - 1)].norm() + h[(l, l)].norm();
            if h[(l, l - 1)].norm() <= f64::EPSILON * s || h[(l, l - 1)].norm() < f64::MIN_POSITIVE {
                h[(l, l - 1)] = Z;
                break;
            }
            l -= 1;
        }
        if l == hi {
            ev[hi] = h[(hi, hi)];
            hi -= 1;
            iter = 0;
            continue;
        }
        iter += 1;
        if iter > 300 {
            // No convergence: report the diagonal of the active block.
            for i in l..=hi {
                ev[i] = h[(i, i)];
            }
            if l == 0 {
                break;
            }
            hi = l - 1;
            iter = 0;
            continue;
        }
        // Wilkinson shift from the trailing 2x2 block.
        let (a11, a12, a21, a22) = (h[(hi - 1, hi - 1)], h[(hi - 1, hi)], h[(hi, hi - 1)], h[(hi, hi)]);
        let mu = if iter % 11 == 10 {
            // Exceptional shift.
            a22 + C::new(h[(hi, hi - 1)].norm() * 0.75, 0.0)
        } else {
            let tr = (a11 + a22) / 2.0;
            let det = a11 * a22 - a12 * a21;
            let disc = (tr * tr - det).sqrt();
            let e1 = tr + disc;
            let e2 = tr - disc;
            if (e1 - a22).norm() < (e2 - a22).norm() {
                e1
            } else {
                e2
            }
        };
        // QR step on the active block l..=hi with Givens rotations.
        for i in l..=hi {
            h[(i, i)] -= mu;
        }
        let mut rots: Vec<(C, C)> = Vec::with_capacity(hi - l);
        for k in l..hi {
            let x = h[(k, k)];
            let y = h[(k + 1, k)];
            let r = (x.norm_sqr() + y.norm_sqr()).sqrt();
            let (c, s) = if r == 0.0 { (C::new(1.0, 0.0), Z) } else { (x / r, y / r) };
            // G = [c^* s^*; -s c], rows k, k+1.
            for j in k..=hi {
                let p = h[(k, j)];
                let q = h[(k + 1, j)];
                h[(k, j)] = c.conj() * p + s.conj() * q;
                h[(k + 1, j)] = -s * p + c * q;
            }
            rots.push((c, s));
        }
        for (t, k) in (l..hi).enumerate() {
            let (c, s) = rots[t];
            // Multiply by G^H on columns k, k+1.
            for i in l..=(k + 1).min(hi) {
                let p = h[(i, k)];
                let q = h[(i, k + 1)];
                h[(i, k)] = p * c + q * s;
                h[(i, k + 1)] = -p * s.conj() + q * c.conj();
            }
        }
        for i in l..=hi {
            h[(i, i)] += mu;
        }
    }
    ev
}

/// An orthonormal basis of the span of the leading `k` left singular vectors
/// of the Hankel matrix `hankel(x(1:m), x(m:end))` (MATLAB `U(:,1:k)` of
/// `svd(H)`, up to a unitary change of basis inside that span, which is all
/// HSVD depends on). Computed from the eigenvectors of the Gram matrix
/// `H'H`: Householder tridiagonalisation, bisection for the leading
/// eigenvalues and inverse iteration for their vectors.
pub fn hankel_left_subspace(x: &[C], m: usize, k: usize) -> CMat {
    let n = x.len() - m + 1;
    // Gram matrix G(i,j) = sum_r conj(x[r+i]) x[r+j], r = 0..m.
    let mut g = CMat::zeros(n, n);
    for j in 0..n {
        let mut s = Z;
        for r in 0..m {
            s += x[r].conj() * x[r + j];
        }
        g[(0, j)] = s;
    }
    for i in 1..n {
        for j in i..n {
            let v = g[(i - 1, j - 1)] - x[i - 1].conj() * x[j - 1] + x[i - 1 + m].conj() * x[j - 1 + m];
            g[(i, j)] = v;
        }
    }
    for i in 0..n {
        g[(i, i)] = C::new(g[(i, i)].re, 0.0);
        for j in i + 1..n {
            g[(j, i)] = g[(i, j)].conj();
        }
    }
    let k = k.min(n);
    let v = hermitian_top_eigvecs(g, k);
    // U = H V, columns normalised, then orthonormalised (Gram-Schmidt twice).
    let mut u = CMat::zeros(m, k);
    for c in 0..k {
        for r in 0..m {
            let mut s = Z;
            for (j, vj) in v.col_slice(c).iter().enumerate() {
                s += x[r + j] * vj;
            }
            u[(r, c)] = s;
        }
    }
    orthonormalise(&mut u);
    u
}

fn orthonormalise(u: &mut CMat) {
    let m = u.rows;
    for c in 0..u.cols {
        for _ in 0..2 {
            for p in 0..c {
                let mut s = Z;
                for r in 0..m {
                    s += u[(r, p)].conj() * u[(r, c)];
                }
                for r in 0..m {
                    let d = u[(r, p)] * s;
                    u[(r, c)] -= d;
                }
            }
        }
        let nrm = (0..m).map(|r| u[(r, c)].norm_sqr()).sum::<f64>().sqrt();
        if nrm > 0.0 {
            for r in 0..m {
                u[(r, c)] /= nrm;
            }
        }
    }
}

/// Eigenvectors of the `k` largest eigenvalues of a Hermitian matrix,
/// in descending order of eigenvalue.
pub fn hermitian_top_eigvecs(mut a: CMat, k: usize) -> CMat {
    let n = a.rows;
    let mut diag = vec![0.0; n];
    let mut off = vec![Z; n.saturating_sub(1)];
    let mut refl: Vec<Vec<C>> = Vec::with_capacity(n);
    // Householder tridiagonalisation, lower triangle, A <- P A P.
    let mut p = vec![Z; n];
    for c in 0..n.saturating_sub(1) {
        let len = n - c - 1;
        let mut norm = 0.0;
        for i in c + 1..n {
            norm += a[(i, c)].norm_sqr();
        }
        let norm = norm.sqrt();
        let x0 = a[(c + 1, c)];
        if len == 1 || norm == 0.0 || norm == x0.norm() && x0.im == 0.0 && len == 1 {
            refl.push(Vec::new());
            off[c] = x0;
            diag[c] = a[(c, c)].re;
            continue;
        }
        let ph = if x0.norm() == 0.0 { C::new(1.0, 0.0) } else { x0 / x0.norm() };
        let alpha = -ph * norm;
        let mut v: Vec<C> = (c + 1..n).map(|i| a[(i, c)]).collect();
        v[0] -= alpha;
        let vn = v.iter().map(|z| z.norm_sqr()).sum::<f64>().sqrt();
        if vn == 0.0 {
            refl.push(Vec::new());
            off[c] = x0;
            diag[c] = a[(c, c)].re;
            continue;
        }
        for z in v.iter_mut() {
            *z /= vn;
        }
        // p = A22 v (A22 Hermitian, use full storage columns).
        for z in p[..len].iter_mut() {
            *z = Z;
        }
        for (t, j) in (c + 1..n).enumerate() {
            let vj = v[t];
            let col = &a.data[j * n + c + 1..j * n + n];
            for (pi, aij) in p[..len].iter_mut().zip(col) {
                *pi += aij * vj;
            }
        }
        let mut kk = Z;
        for t in 0..len {
            kk += v[t].conj() * p[t];
        }
        // w = p - (v^H p) v ; A22 -= 2 (v w^H + w v^H)
        let w: Vec<C> = (0..len).map(|t| p[t] - kk * v[t]).collect();
        for (tj, j) in (c + 1..n).enumerate() {
            let wj = w[tj].conj() * 2.0;
            let vj = v[tj].conj() * 2.0;
            let col = &mut a.data[j * n + c + 1..j * n + n];
            for (ti, aij) in col.iter_mut().enumerate() {
                *aij -= v[ti] * wj + w[ti] * vj;
            }
        }
        diag[c] = a[(c, c)].re;
        off[c] = alpha;
        refl.push(v);
    }
    if n > 0 {
        diag[n - 1] = a[(n - 1, n - 1)].re;
    }
    // Diagonal unitary scaling to a real tridiagonal: d_{c+1} = d_c e_c/|e_c|.
    let mut dph = vec![C::new(1.0, 0.0); n];
    let mut e = vec![0.0; n.saturating_sub(1)];
    for c in 0..off.len() {
        let m = off[c].norm();
        e[c] = m;
        dph[c + 1] = if m == 0.0 { dph[c] } else { dph[c] * off[c] / m };
    }
    let lam = tridiag_top_eigvals(&diag, &e, k);
    let ys = tridiag_eigvecs(&diag, &e, &lam);
    let mut out = CMat::zeros(n, lam.len());
    for (c, y) in ys.iter().enumerate() {
        let mut z: Vec<C> = (0..n).map(|i| dph[i] * y[i]).collect();
        for r in (0..refl.len()).rev() {
            let v = &refl[r];
            if v.is_empty() {
                continue;
            }
            let seg = &mut z[r + 1..n];
            let mut s = Z;
            for (vi, zi) in v.iter().zip(seg.iter()) {
                s += vi.conj() * zi;
            }
            s *= 2.0;
            for (vi, zi) in v.iter().zip(seg.iter_mut()) {
                *zi -= vi * s;
            }
        }
        for i in 0..n {
            out[(i, c)] = z[i];
        }
    }
    out
}

/// Number of eigenvalues of the symmetric tridiagonal (d, e) below `x`.
fn sturm(d: &[f64], e: &[f64], x: f64) -> usize {
    let mut count = 0;
    let mut q = d[0] - x;
    let tiny = f64::MIN_POSITIVE;
    if q < 0.0 {
        count += 1;
    }
    for i in 1..d.len() {
        let qq = if q == 0.0 { tiny } else { q };
        q = d[i] - x - e[i - 1] * e[i - 1] / qq;
        if q < 0.0 {
            count += 1;
        }
    }
    count
}

/// The `k` largest eigenvalues (descending) by bisection.
fn tridiag_top_eigvals(d: &[f64], e: &[f64], k: usize) -> Vec<f64> {
    let n = d.len();
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for i in 0..n {
        let r = if i > 0 { e[i - 1].abs() } else { 0.0 } + if i + 1 < n { e[i].abs() } else { 0.0 };
        lo = lo.min(d[i] - r);
        hi = hi.max(d[i] + r);
    }
    let span = (hi - lo).abs().max(hi.abs()).max(f64::MIN_POSITIVE);
    lo -= 1e-12 * span;
    hi += 1e-12 * span;
    let mut out = Vec::with_capacity(k);
    for j in 0..k.min(n) {
        // The (n-1-j)-th eigenvalue (0-based ascending): smallest x with count(x) >= n-j.
        let target = n - j;
        let (mut a, mut b) = (lo, hi);
        for _ in 0..200 {
            let mid = 0.5 * (a + b);
            if mid <= a || mid >= b {
                break;
            }
            if sturm(d, e, mid) >= target {
                b = mid;
            } else {
                a = mid;
            }
        }
        out.push(0.5 * (a + b));
    }
    out
}

/// Eigenvectors for the given eigenvalues by inverse iteration with
/// reorthogonalisation inside clusters (as LAPACK dstein).
fn tridiag_eigvecs(d: &[f64], e: &[f64], lam: &[f64]) -> Vec<Vec<f64>> {
    let n = d.len();
    let onenrm = (0..n)
        .map(|i| d[i].abs() + if i > 0 { e[i - 1].abs() } else { 0.0 } + if i + 1 < n { e[i].abs() } else { 0.0 })
        .fold(0.0, f64::max);
    let ortol = 1e-3 * onenrm;
    let eps = f64::EPSILON * onenrm.max(f64::MIN_POSITIVE);
    let mut vecs: Vec<Vec<f64>> = Vec::with_capacity(lam.len());
    for (j, &l) in lam.iter().enumerate() {
        // Perturb repeated eigenvalues slightly apart, as dstein does.
        let mut x: Vec<f64> = (0..n).map(|i| 1.0 + 0.1 * (((i * 7919 + j * 104729) % 1000) as f64 / 1000.0 - 0.5)).collect();
        let (dl, dd, du, du2, piv) = tridiag_lu(d, e, l, eps);
        for _ in 0..5 {
            tridiag_solve(&dl, &dd, &du, &du2, &piv, &mut x);
            for (p, v) in vecs.iter().enumerate() {
                if (lam[p] - l).abs() < ortol {
                    let s: f64 = v.iter().zip(&x).map(|(a, b)| a * b).sum();
                    for (xi, vi) in x.iter_mut().zip(v) {
                        *xi -= s * vi;
                    }
                }
            }
            let nrm = x.iter().map(|v| v * v).sum::<f64>().sqrt();
            if nrm == 0.0 {
                break;
            }
            for v in x.iter_mut() {
                *v /= nrm;
            }
        }
        vecs.push(x);
    }
    vecs
}

type TriLu = (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<bool>);

/// LU with partial pivoting of T - lam I (LAPACK dgttrf layout).
fn tridiag_lu(d: &[f64], e: &[f64], lam: f64, eps: f64) -> TriLu {
    let n = d.len();
    let mut dd: Vec<f64> = d.iter().map(|v| v - lam).collect();
    let mut dl: Vec<f64> = e.to_vec();
    let mut du: Vec<f64> = e.to_vec();
    let mut du2 = vec![0.0; n.saturating_sub(2)];
    let mut piv = vec![false; n.saturating_sub(1)];
    for i in 0..n.saturating_sub(1) {
        if dd[i].abs() >= dl[i].abs() {
            if dd[i] == 0.0 {
                dd[i] = eps;
            }
            let f = dl[i] / dd[i];
            dl[i] = f;
            dd[i + 1] -= f * du[i];
        } else {
            let f = dd[i] / dl[i];
            dd[i] = dl[i];
            dl[i] = f;
            let t = du[i];
            du[i] = dd[i + 1];
            dd[i + 1] = t - f * dd[i + 1];
            if i + 1 < n - 1 {
                du2[i] = du[i + 1];
                du[i + 1] = -f * du[i + 1];
            }
            piv[i] = true;
        }
    }
    if n > 0 && dd[n - 1] == 0.0 {
        dd[n - 1] = eps;
    }
    for v in dd.iter_mut() {
        if v.abs() < eps {
            *v = if *v < 0.0 { -eps } else { eps };
        }
    }
    (dl, dd, du, du2, piv)
}

fn tridiag_solve(dl: &[f64], dd: &[f64], du: &[f64], du2: &[f64], piv: &[bool], x: &mut [f64]) {
    let n = dd.len();
    for i in 0..n.saturating_sub(1) {
        if piv[i] {
            x.swap(i, i + 1);
        }
        x[i + 1] -= dl[i] * x[i];
    }
    x[n - 1] /= dd[n - 1];
    if n > 1 {
        x[n - 2] = (x[n - 2] - du[n - 2] * x[n - 1]) / dd[n - 2];
    }
    for i in (0..n.saturating_sub(2)).rev() {
        x[i] = (x[i] - du[i] * x[i + 1] - du2[i] * x[i + 2]) / dd[i];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn least_squares_line() {
        let a = CMat { rows: 4, cols: 2, data: [1.0, 2.0, 3.0, 4.0, 1.0, 1.0, 1.0, 1.0].iter().map(|&v| C::new(v, 0.0)).collect() };
        let b = CMat::from_col(&[C::new(3.0, 1.0), C::new(5.0, 2.0), C::new(7.0, 3.0), C::new(9.0, 4.0)]);
        let x = lstsq(&a, &b);
        assert!((x[(0, 0)] - C::new(2.0, 1.0)).norm() < 1e-12);
        assert!((x[(1, 0)] - C::new(1.0, 0.0)).norm() < 1e-12);
    }

    #[test]
    fn eigenvalues_of_companion() {
        // Roots 1, 2i, -3.
        let roots = [C::new(1.0, 0.0), C::new(0.0, 2.0), C::new(-3.0, 0.0)];
        let mut a = CMat::zeros(3, 3);
        // Upper triangular with those diagonals, then a similarity by a dense matrix.
        for i in 0..3 {
            a[(i, i)] = roots[i];
        }
        a[(0, 1)] = C::new(0.5, 0.2);
        a[(0, 2)] = C::new(-1.0, 0.3);
        a[(1, 2)] = C::new(2.0, -1.0);
        let s = CMat { rows: 3, cols: 3, data: [2.0, 1.0, 0.0, 1.0, 3.0, 1.0, 0.0, 1.0, 4.0].iter().map(|&v| C::new(v, 0.1)).collect() };
        let si = lstsq(&s, &CMat { rows: 3, cols: 3, data: (0..9).map(|k| if k % 4 == 0 { C::new(1.0, 0.0) } else { Z }).collect() });
        let b = s.mul(&a).mul(&si);
        let mut ev = eigvals(&b);
        ev.sort_by(|x, y| x.re.partial_cmp(&y.re).unwrap());
        assert!((ev[0] - roots[2]).norm() < 1e-9, "{:?}", ev);
        assert!((ev[1] - roots[1]).norm() < 1e-9, "{:?}", ev);
        assert!((ev[2] - roots[0]).norm() < 1e-9, "{:?}", ev);
    }

    #[test]
    fn hermitian_leading_vectors() {
        let n = 12;
        let mut a = CMat::zeros(n, n);
        for i in 0..n {
            for j in 0..n {
                let v = C::new(((i * 3 + j * 5) % 7) as f64 + if i == j { 10.0 * i as f64 } else { 0.0 }, 0.3 * (i as f64 - j as f64));
                a[(i, j)] = v;
            }
        }
        let a = {
            let h = a.h();
            let mut s = a.clone();
            for k in 0..s.data.len() {
                s.data[k] = (a.data[k] + h.data[k]) / 2.0;
            }
            s
        };
        let v = hermitian_top_eigvecs(a.clone(), 3);
        for c in 0..3 {
            let x = CMat::from_col(v.col_slice(c));
            let ax = a.mul(&x);
            let lam = (x.h().mul(&ax))[(0, 0)];
            let res: f64 = (0..n).map(|i| (ax[(i, 0)] - lam * x[(i, 0)]).norm_sqr()).sum::<f64>().sqrt();
            assert!(res < 1e-9, "residual {res}");
        }
    }
}

//! Non-negative least squares: a statement-by-statement port of Lawson and Hanson's NNLS as
//! scipy 1.11.4 ships it (scipy/optimize/__nnls/nnls.f), which AMICO 1.5.4 calls through
//! `scipy.optimize.nnls`. NODDI's first fit has more atoms than measurements, so its solution is
//! not unique, and only the same pivot order gives AMICO's answer. Labels in comments are the
//! Fortran statement numbers. Indices are 1-based as in the Fortran; `at` maps them.
// A statement port: loops index as the Fortran does, and its guards stay even where Rust types
// make them redundant.
#![allow(
    clippy::needless_range_loop,
    clippy::manual_memcpy,
    clippy::absurd_extreme_comparisons
)]

/// Column-major M×N matrix with 1-based access.
struct Mat<'a> {
    a: &'a mut [f64],
    m: usize,
}

impl Mat<'_> {
    fn at(&self, l: usize, j: usize) -> usize {
        (j - 1) * self.m + (l - 1)
    }
}

/// H12 mode 1: builds the Householder transformation of column `u` that zeroes rows
/// `l1..=m` against pivot row `lpivot`. Returns `up`, or None when the column is zero there.
fn h12_construct(lpivot: usize, l1: usize, m: usize, u: &mut [f64]) -> Option<f64> {
    if 0 >= lpivot || lpivot >= l1 || l1 > m {
        return None;
    }
    let mut cl = u[lpivot - 1].abs();
    for j in l1..=m {
        cl = u[j - 1].abs().max(cl);
    }
    if cl <= 0.0 {
        return None;
    }
    let clinv = 1.0 / cl;
    let mut sm = (u[lpivot - 1] * clinv).powi(2);
    for j in l1..=m {
        sm += (u[j - 1] * clinv).powi(2);
    }
    cl *= sm.sqrt();
    if u[lpivot - 1] > 0.0 {
        cl = -cl;
    }
    let up = u[lpivot - 1] - cl;
    u[lpivot - 1] = cl;
    Some(up)
}

/// H12 mode 2: applies the transformation held in `u` and `up` to the vector `c`.
fn h12_apply(lpivot: usize, l1: usize, m: usize, u: &[f64], up: f64, c: &mut [f64]) {
    if 0 >= lpivot || lpivot >= l1 || l1 > m {
        return;
    }
    if u[lpivot - 1].abs() <= 0.0 {
        return;
    }
    let b = up * u[lpivot - 1];
    if b >= 0.0 {
        return;
    }
    let b = 1.0 / b;
    let mut sm = c[lpivot - 1] * up;
    for i in l1..=m {
        sm += c[i - 1] * u[i - 1];
    }
    if sm != 0.0 {
        sm *= b;
        c[lpivot - 1] += sm * up;
        for i in l1..=m {
            c[i - 1] += sm * u[i - 1];
        }
    }
}

/// G1: the Givens rotation that zeroes `b` against `a`. Returns (cterm, sterm, sig).
fn g1(a: f64, b: f64) -> (f64, f64, f64) {
    if a.abs() > b.abs() {
        let xr = b / a;
        let yr = (1.0 + xr * xr).sqrt();
        let cterm = (1.0 / yr).copysign(a);
        return (cterm, cterm * xr, a.abs() * yr);
    }
    if b != 0.0 {
        let xr = a / b;
        let yr = (1.0 + xr * xr).sqrt();
        let sterm = (1.0 / yr).copysign(b);
        return (sterm * xr, sterm, b.abs() * yr);
    }
    (0.0, 1.0, 0.0)
}

/// Solves min ‖A x − b‖ subject to x ≥ 0. `a` is column-major M×N and is overwritten, as is `b`.
/// Returns x; stops after 3N iterations, as scipy's default does (scipy then raises; AMICO never
/// reaches it on these problem sizes).
pub fn nnls(a: &mut [f64], m: usize, n: usize, b: &mut [f64]) -> Vec<f64> {
    assert_eq!(a.len(), m * n);
    assert_eq!(b.len(), m);
    let mut x = vec![0.0f64; n + 1];
    if m == 0 || n == 0 {
        x.remove(0);
        return x;
    }
    let a = Mat { a, m };
    let mut w = vec![0.0f64; n + 1];
    let mut zz = vec![0.0f64; m + 1];
    // index[1..=n]; zz and b use 1-based helpers below.
    let mut index: Vec<usize> = (0..=n).collect();
    let itmax = 3 * n;
    let mut iter = 0;
    let iz2 = n;
    let mut iz1 = 1;
    let mut nsetp = 0usize;
    let mut npp1 = 1usize;
    let mut up = 0.0f64;
    let bv = |b: &[f64], l: usize| b[l - 1];

    // Back substitution (label 400): solves the triangular system for zz[1..=nsetp].
    let solve = |a: &Mat, index: &[usize], zz: &mut [f64], nsetp: usize| {
        let mut jj = 0usize;
        for l in 1..=nsetp {
            let ip = nsetp + 1 - l;
            if l != 1 {
                for ii in 1..=ip {
                    zz[ii] -= a.a[a.at(ii, jj)] * zz[ip + 1];
                }
            }
            jj = index[ip];
            zz[ip] /= a.a[a.at(ip, jj)];
        }
    };

    // Label 30: main loop.
    'main: loop {
        if iz1 > iz2 || nsetp >= m {
            break 'main;
        }
        for iz in iz1..=iz2 {
            let j = index[iz];
            let mut sm = 0.0;
            for l in npp1..=m {
                sm += a.a[a.at(l, j)] * bv(b, l);
            }
            w[j] = sm;
        }
        // Label 60.
        let (iz, j) = loop {
            let mut wmax = 0.0;
            let mut izmax = 0;
            for iz in iz1..=iz2 {
                let j = index[iz];
                if w[j] > wmax {
                    wmax = w[j];
                    izmax = iz;
                }
            }
            if wmax <= 0.0 {
                break 'main;
            }
            let iz = izmax;
            let j = index[iz];
            let col = a.at(1, j);
            let asave = a.a[a.at(npp1, j)];
            if let Some(u) = h12_construct(npp1, npp1 + 1, m, &mut a.a[col..col + m]) {
                up = u;
            }
            let mut unorm = 0.0;
            for l in 1..=nsetp {
                unorm += a.a[a.at(l, j)].powi(2);
            }
            let unorm = unorm.sqrt();
            let mut accept = false;
            if (unorm + a.a[a.at(npp1, j)].abs() * 0.01) - unorm > 0.0 {
                for l in 1..=m {
                    zz[l] = bv(b, l);
                }
                h12_apply(npp1, npp1 + 1, m, &a.a[col..col + m], up, &mut zz[1..=m]);
                let ztest = zz[npp1] / a.a[a.at(npp1, j)];
                accept = ztest > 0.0;
            }
            if accept {
                break (iz, j);
            }
            let p = a.at(npp1, j);
            a.a[p] = asave;
            w[j] = 0.0;
        };
        // Label 140.
        for l in 1..=m {
            b[l - 1] = zz[l];
        }
        index[iz] = index[iz1];
        index[iz1] = j;
        iz1 += 1;
        nsetp = npp1;
        npp1 += 1;
        if iz1 <= iz2 {
            let col = a.at(1, j);
            for jz in iz1..=iz2 {
                let jj = index[jz];
                let target = a.at(1, jj);
                let (u, c) = if col < target {
                    let (lo, hi) = a.a.split_at_mut(target);
                    (&lo[col..col + m], &mut hi[..m])
                } else {
                    let (lo, hi) = a.a.split_at_mut(col);
                    (&hi[..m], &mut lo[target..target + m])
                };
                // u is the read-only column j; c is column jj.
                h12_apply(nsetp, npp1, m, u, up, c);
            }
        }
        if nsetp != m {
            for l in npp1..=m {
                let p = a.at(l, j);
                a.a[p] = 0.0;
            }
        }
        w[j] = 0.0;
        solve(&a, &index, &mut zz, nsetp);

        // Label 210: secondary loop.
        loop {
            iter += 1;
            if iter > itmax {
                break 'main;
            }
            let mut alpha = 2.0;
            let mut jj = 0usize;
            for ip in 1..=nsetp {
                let l = index[ip];
                if zz[ip] <= 0.0 {
                    let t = -x[l] / (zz[ip] - x[l]);
                    if alpha > t {
                        alpha = t;
                        jj = ip;
                    }
                }
            }
            if alpha == 2.0 {
                // Label 330.
                for ip in 1..=nsetp {
                    x[index[ip]] = zz[ip];
                }
                continue 'main;
            }
            for ip in 1..=nsetp {
                let l = index[ip];
                x[l] += alpha * (zz[ip] - x[l]);
            }
            let mut i = index[jj];
            // Label 260.
            loop {
                x[i] = 0.0;
                if jj != nsetp {
                    jj += 1;
                    for j in jj..=nsetp {
                        let ii = index[j];
                        index[j - 1] = ii;
                        let (cc, ss, sig) = g1(a.a[a.at(j - 1, ii)], a.a[a.at(j, ii)]);
                        let p = a.at(j - 1, ii);
                        a.a[p] = sig;
                        let p = a.at(j, ii);
                        a.a[p] = 0.0;
                        for l in 1..=n {
                            if l != ii {
                                let p0 = a.at(j - 1, l);
                                let p1 = a.at(j, l);
                                let temp = a.a[p0];
                                a.a[p0] = cc * temp + ss * a.a[p1];
                                a.a[p1] = -ss * temp + cc * a.a[p1];
                            }
                        }
                        let temp = b[j - 2];
                        b[j - 2] = cc * temp + ss * b[j - 1];
                        b[j - 1] = -ss * temp + cc * b[j - 1];
                    }
                }
                npp1 = nsetp;
                nsetp -= 1;
                iz1 -= 1;
                index[iz1] = i;
                let mut again = None;
                for p in 1..=nsetp {
                    let k = index[p];
                    if x[k] <= 0.0 {
                        again = Some((p, k));
                        break;
                    }
                }
                match again {
                    Some((p, k)) => {
                        jj = p;
                        i = k;
                    }
                    None => break,
                }
            }
            for l in 1..=m {
                zz[l] = b[l - 1];
            }
            solve(&a, &index, &mut zz, nsetp);
        }
    }
    x.remove(0);
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column_major(rows: &[&[f64]]) -> (Vec<f64>, usize, usize) {
        let m = rows.len();
        let n = rows[0].len();
        let mut a = vec![0.0; m * n];
        for (i, r) in rows.iter().enumerate() {
            for (j, v) in r.iter().enumerate() {
                a[j * m + i] = *v;
            }
        }
        (a, m, n)
    }

    #[test]
    fn solves_an_unconstrained_case() {
        let (mut a, m, n) = column_major(&[&[1.0, 0.0], &[0.0, 1.0], &[1.0, 1.0]]);
        let mut b = vec![1.0, 2.0, 3.0];
        let x = nnls(&mut a, m, n, &mut b);
        assert!(
            (x[0] - 1.0).abs() < 1e-12 && (x[1] - 2.0).abs() < 1e-12,
            "{x:?}"
        );
    }

    #[test]
    fn clamps_a_negative_coefficient() {
        // Unconstrained solution is (2, -1); the constrained one keeps only the first column.
        let (mut a, m, n) = column_major(&[&[1.0, 1.0], &[1.0, 2.0], &[1.0, 3.0]]);
        let mut b = vec![1.0, 0.0, -1.0];
        let x = nnls(&mut a, m, n, &mut b);
        assert_eq!(x[1], 0.0);
        assert!(x[0].abs() < 1e-12, "{x:?}");
    }

    #[test]
    fn matches_scipy_on_an_underdetermined_case() {
        // scipy.optimize.nnls(A, b) with scipy 1.11.4 gives [0, 0.125, 0, 0.875] here.
        let (mut a, m, n) = column_major(&[&[1.0, 2.0, 1.0, 0.0], &[0.0, 1.0, 1.0, 1.0]]);
        let mut b = vec![0.25, 1.0];
        let x = nnls(&mut a, m, n, &mut b);
        let expected = [0.0, 0.125, 0.0, 0.875];
        for (got, want) in x.iter().zip(expected) {
            assert!((got - want).abs() < 1e-12, "{x:?}");
        }
    }
}

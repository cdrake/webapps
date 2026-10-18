// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of
// the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Port of MRtrix3 3.0.8 cmd/mrdegibbs.cpp (Copyright (c) 2008-2025 the MRtrix3 contributors,
// MPL-2.0): Gibbs ringing removal by local subvoxel shifts (Kellner et al. 2016). The loops keep
// the C++ order; names follow it (`unring_2d`, `unring_1d`, `nsh`, `min_w`, `max_w`).
#![allow(clippy::needless_range_loop)]

//! Gibbs-ringing removal for 2D slices of a volume, as MRtrix `mrdegibbs` does it.

use rustfft::num_complex::Complex64;
use rustfft::{Fft, FftPlanner};
use std::f64::consts::PI;
use std::sync::Arc;

/// `mrdegibbs` defaults: `-nshifts 20 -minW 1 -maxW 3`.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub nshifts: usize,
    pub min_w: usize,
    pub max_w: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            nshifts: 20,
            min_w: 1,
            max_w: 3,
        }
    }
}

/// A column-major complex matrix, as Eigen's MatrixXcd: element (row, col) at `col * rows + row`.
#[derive(Clone)]
struct Matrix {
    rows: usize,
    cols: usize,
    data: Vec<Complex64>,
}

impl Matrix {
    fn new(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            data: vec![Complex64::new(0.0, 0.0); rows * cols],
        }
    }

    fn at(&self, row: usize, col: usize) -> Complex64 {
        self.data[col * self.rows + row]
    }

    fn set(&mut self, row: usize, col: usize, value: Complex64) {
        self.data[col * self.rows + row] = value;
    }

    fn transpose(&self) -> Matrix {
        let mut out = Matrix::new(self.cols, self.rows);
        for c in 0..self.cols {
            for r in 0..self.rows {
                out.set(c, r, self.at(r, c));
            }
        }
        out
    }
}

/// Forward and inverse FFTs of the lengths a slice needs. The inverse is scaled by 1/n, as
/// Eigen::FFT::inv is.
struct Transforms {
    planner: FftPlanner<f64>,
    forward: Vec<(usize, Arc<dyn Fft<f64>>)>,
    inverse: Vec<(usize, Arc<dyn Fft<f64>>)>,
}

impl Transforms {
    fn new() -> Self {
        Self {
            planner: FftPlanner::new(),
            forward: Vec::new(),
            inverse: Vec::new(),
        }
    }

    fn plan(&mut self, n: usize, inverse: bool) -> Arc<dyn Fft<f64>> {
        let cache = if inverse {
            &mut self.inverse
        } else {
            &mut self.forward
        };
        if let Some((_, plan)) = cache.iter().find(|(len, _)| *len == n) {
            return plan.clone();
        }
        let plan = if inverse {
            self.planner.plan_fft_inverse(n)
        } else {
            self.planner.plan_fft_forward(n)
        };
        cache.push((n, plan.clone()));
        plan
    }

    fn transform(&mut self, values: &mut [Complex64], inverse: bool) {
        let n = values.len();
        self.plan(n, inverse).process(values);
        if inverse {
            let scale = 1.0 / n as f64;
            for v in values.iter_mut() {
                *v *= scale;
            }
        }
    }

    /// Transforms every row (along the columns) of `m`.
    fn rows(&mut self, m: &mut Matrix, inverse: bool) {
        let mut line = vec![Complex64::new(0.0, 0.0); m.cols];
        for r in 0..m.rows {
            for c in 0..m.cols {
                line[c] = m.at(r, c);
            }
            self.transform(&mut line, inverse);
            for c in 0..m.cols {
                m.set(r, c, line[c]);
            }
        }
    }

    /// Transforms every column (along the rows) of `m`.
    fn cols(&mut self, m: &mut Matrix, inverse: bool) {
        let rows = m.rows;
        for c in 0..m.cols {
            self.transform(&mut m.data[c * rows..(c + 1) * rows], inverse);
        }
    }
}

/// Removes Gibbs ringing from one 2D slice, `rows` × `cols` values with the first index fastest
/// (as a NIfTI slice with axes 0 and 1 in plane). Returns the corrected slice.
pub fn unring_slice(slice: &[f32], rows: usize, cols: usize, options: Options) -> Vec<f32> {
    assert_eq!(slice.len(), rows * cols);
    let mut transforms = Transforms::new();
    let mut im1 = Matrix::new(rows, cols);
    for c in 0..cols {
        for r in 0..rows {
            im1.set(r, c, Complex64::new(slice[c * rows + r] as f64, 0.0));
        }
    }
    let im1 = unring_2d(im1, &mut transforms, options);
    let mut out = vec![0.0f32; rows * cols];
    for c in 0..cols {
        for r in 0..rows {
            out[c * rows + r] = im1.at(r, c).re as f32;
        }
    }
    out
}

fn unring_2d(mut im1: Matrix, transforms: &mut Transforms, options: Options) -> Matrix {
    transforms.rows(&mut im1, false);
    transforms.cols(&mut im1, false);
    let mut im2 = Matrix::new(im1.rows, im1.cols);
    for k in 0..im1.cols {
        let ck = (1.0 + (2.0 * PI * (k as f64 / im1.cols as f64)).cos()) * 0.5;
        for j in 0..im1.rows {
            let cj = (1.0 + (2.0 * PI * (j as f64 / im1.rows as f64)).cos()) * 0.5;
            if ck + cj != 0.0 {
                im2.set(j, k, im1.at(j, k) * (cj / (ck + cj)));
                let v = im1.at(j, k) * (ck / (ck + cj));
                im1.set(j, k, v);
            } else {
                im1.set(j, k, Complex64::new(0.0, 0.0));
                im2.set(j, k, Complex64::new(0.0, 0.0));
            }
        }
    }
    transforms.rows(&mut im1, true);
    transforms.cols(&mut im2, true);
    unring_1d(&mut im1, transforms, options);
    let mut im2t = im2.transpose();
    unring_1d(&mut im2t, transforms, options);
    let im2 = im2t.transpose();
    for (a, b) in im1.data.iter_mut().zip(&im2.data) {
        *a += *b;
    }
    im1
}

/// Shifts each column of `eig` (k-space along the rows) by subvoxel amounts and keeps, per
/// sample, the shift whose neighbourhood has the least total variation.
fn unring_1d(eig: &mut Matrix, transforms: &mut Transforms, options: Options) {
    let Options {
        nshifts: nsh,
        min_w,
        max_w,
    } = options;
    let n = eig.rows;
    let numlines = eig.cols;
    let width = 2 * nsh + 1;
    let mut shifted = Matrix::new(n, width);
    let mut shifts = vec![0i64; width];
    for j in 0..nsh {
        shifts[j + 1] = j as i64 + 1;
        shifts[1 + nsh + j] = -(j as i64 + 1);
    }
    let mut tv1 = vec![0.0f64; width];
    let mut tv2 = vec![0.0f64; width];
    let ni = n as i64;
    let m = |i: i64| -> usize { i.rem_euclid(ni) as usize };
    for k in 0..numlines {
        for l in 0..n {
            shifted.set(l, 0, eig.at(l, k));
        }
        let maxn = if n & 1 == 1 { (n - 1) / 2 } else { n / 2 - 1 };
        for j in 1..width {
            let phi = PI * shifts[j] as f64 / (n * nsh) as f64;
            let u = Complex64::new(phi.cos(), phi.sin());
            let mut e = Complex64::new(1.0, 0.0);
            shifted.set(0, j, shifted.at(0, 0));
            if n & 1 == 0 {
                shifted.set(n / 2, j, Complex64::new(0.0, 0.0));
            }
            for l in 0..maxn {
                e = u * e;
                let big_l = l + 1;
                shifted.set(big_l, j, e * shifted.at(big_l, 0));
                let big_l = n - 1 - l;
                shifted.set(big_l, j, e.conj() * shifted.at(big_l, 0));
            }
        }
        transforms.cols(&mut shifted, true);
        let at = |i: i64, j: usize| shifted.at(m(i), j);
        let (min_w, max_w) = (min_w as i64, max_w as i64);
        for j in 0..width {
            tv1[j] = 0.0;
            tv2[j] = 0.0;
            for t in min_w..=max_w {
                tv1[j] += (at(ni - t, j).re - at(ni - t - 1, j).re).abs();
                tv1[j] += (at(ni - t, j).im - at(ni - t - 1, j).im).abs();
                tv2[j] += (at(ni + t, j).re - at(ni + t + 1, j).re).abs();
                tv2[j] += (at(ni + t, j).im - at(ni + t + 1, j).im).abs();
            }
        }
        for l in 0..n {
            let li = l as i64;
            let mut min_tv = f64::MAX;
            let mut minidx = 0usize;
            for j in 0..width {
                if tv1[j] < min_tv {
                    min_tv = tv1[j];
                    minidx = j;
                }
                if tv2[j] < min_tv {
                    min_tv = tv2[j];
                    minidx = j;
                }
                tv1[j] += (at(li - min_w + 1 + ni, j).re - at(li - min_w + ni, j).re).abs();
                tv1[j] -= (at(li - max_w + ni, j).re - at(li - (max_w + 1) + ni, j).re).abs();
                tv2[j] += (at(li + max_w + 1 + ni, j).re - at(li + (max_w + 2) + ni, j).re).abs();
                tv2[j] -= (at(li + min_w + ni, j).re - at(li + (min_w + 1) + ni, j).re).abs();
                tv1[j] += (at(li - min_w + 1 + ni, j).im - at(li - min_w + ni, j).im).abs();
                tv1[j] -= (at(li - max_w + ni, j).im - at(li - (max_w + 1) + ni, j).im).abs();
                tv2[j] += (at(li + max_w + 1 + ni, j).im - at(li + (max_w + 2) + ni, j).im).abs();
                tv2[j] -= (at(li + min_w + ni, j).im - at(li + (min_w + 1) + ni, j).im).abs();
            }
            let a0 = at(li - 1 + ni, minidx);
            let a1 = at(li, minidx);
            let a2 = at(li + 1 + ni, minidx);
            let s = shifts[minidx] as f64 / (2.0 * nsh as f64);
            let value = if s > 0.0 {
                Complex64::new(a1.re * (1.0 - s) + a0.re * s, a1.im * (1.0 - s) + a0.im * s)
            } else {
                Complex64::new(a1.re * (1.0 + s) - a2.re * s, a1.im * (1.0 + s) - a2.im * s)
            };
            eig.set(l, k, value);
        }
    }
}

/// Removes Gibbs ringing from every 2D slice of a volume series. `data` holds `dims[0]` ×
/// `dims[1]` × `dims[2]` × `frames` values, first index fastest (NIfTI order); `slice_axes` names
/// the two in-plane axes among 0, 1 and 2 (MRtrix default `[0, 1]`).
pub fn unring_volume(
    data: &[f32],
    dims: [usize; 3],
    frames: usize,
    slice_axes: [usize; 2],
    options: Options,
) -> Vec<f32> {
    let [a, b] = slice_axes;
    assert!(a < 3 && b < 3 && a != b);
    let outer = 3 - a - b;
    let strides = [1, dims[0], dims[0] * dims[1]];
    let voxels = dims[0] * dims[1] * dims[2];
    assert_eq!(data.len(), voxels * frames);
    let mut out = vec![0.0f32; data.len()];
    let mut slice = vec![0.0f32; dims[a] * dims[b]];
    for frame in 0..frames {
        let base = frame * voxels;
        for o in 0..dims[outer] {
            for j in 0..dims[b] {
                for i in 0..dims[a] {
                    slice[j * dims[a] + i] =
                        data[base + o * strides[outer] + j * strides[b] + i * strides[a]];
                }
            }
            let fixed = unring_slice(&slice, dims[a], dims[b], options);
            for j in 0..dims[b] {
                for i in 0..dims[a] {
                    out[base + o * strides[outer] + j * strides[b] + i * strides[a]] =
                        fixed[j * dims[a] + i];
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 64 × 48 slice of a square of 100 whose edges fall between samples, reconstructed from
    /// the central k-space of an 8× finer object, as an MRI acquisition truncates it. `truth` is
    /// the square sampled at the slice's resolution.
    fn ringing_square() -> (Vec<f32>, Vec<f32>, usize, usize) {
        let (rows, cols, up) = (64usize, 48usize, 8usize);
        let (hr, hc) = (rows * up, cols * up);
        let inside = |r: f64, c: f64| (20.3..43.6).contains(&r) && (15.6..31.4).contains(&c);
        let mut t = Transforms::new();
        let mut fine = Matrix::new(hr, hc);
        for c in 0..hc {
            for r in 0..hr {
                let v = if inside(r as f64 / up as f64, c as f64 / up as f64) {
                    100.0
                } else {
                    0.0
                };
                fine.set(r, c, Complex64::new(v, 0.0));
            }
        }
        t.rows(&mut fine, false);
        t.cols(&mut fine, false);
        // Keep the central rows × cols coefficients (frequency index wraps), scaled to the coarse grid.
        let mut coarse = Matrix::new(rows, cols);
        let wrap = |k: usize, n: usize, big: usize| if k < n / 2 { k } else { big - (n - k) };
        let scale = 1.0 / (up * up) as f64;
        for c in 0..cols {
            for r in 0..rows {
                coarse.set(r, c, fine.at(wrap(r, rows, hr), wrap(c, cols, hc)) * scale);
            }
        }
        t.rows(&mut coarse, true);
        t.cols(&mut coarse, true);
        let ringing = (0..cols)
            .flat_map(|c| (0..rows).map(move |r| (c, r)))
            .map(|(c, r)| coarse.at(r, c).re as f32)
            .collect();
        let truth = (0..cols)
            .flat_map(|c| (0..rows).map(move |r| (c, r)))
            .map(|(c, r)| {
                if inside(r as f64, c as f64) {
                    100.0
                } else {
                    0.0
                }
            })
            .collect();
        (truth, ringing, rows, cols)
    }

    /// Ripple energy in the background more than 2 samples from the square: ringing, not blur.
    fn ripple(slice: &[f32], truth: &[f32], rows: usize, cols: usize) -> f64 {
        let near = |r: usize, c: usize| {
            (r.saturating_sub(2)..(r + 3).min(rows)).any(|rr| {
                (c.saturating_sub(2)..(c + 3).min(cols)).any(|cc| truth[cc * rows + rr] > 0.0)
            })
        };
        let mut sum = 0.0;
        for c in 0..cols {
            for r in 0..rows {
                if !near(r, c) {
                    sum += (slice[c * rows + r] as f64).powi(2);
                }
            }
        }
        sum.sqrt()
    }

    #[test]
    fn fft_round_trip_is_identity() {
        let mut t = Transforms::new();
        let mut m = Matrix::new(6, 5);
        for (i, v) in m.data.iter_mut().enumerate() {
            *v = Complex64::new(i as f64, -(i as f64) / 3.0);
        }
        let before = m.data.clone();
        t.rows(&mut m, false);
        t.cols(&mut m, false);
        t.cols(&mut m, true);
        t.rows(&mut m, true);
        for (a, b) in m.data.iter().zip(&before) {
            assert!((a - b).norm() < 1e-12);
        }
    }

    #[test]
    fn unringing_reduces_ringing_around_an_edge() {
        let (truth, ringing, rows, cols) = ringing_square();
        let fixed = unring_slice(&ringing, rows, cols, Options::default());
        let before = ripple(&ringing, &truth, rows, cols);
        let after = ripple(&fixed, &truth, rows, cols);
        assert!(after < 0.5 * before, "ripple {before} -> {after}");
    }

    #[test]
    fn a_constant_slice_is_unchanged() {
        let flat = vec![7.0f32; 32 * 16];
        let fixed = unring_slice(&flat, 32, 16, Options::default());
        for v in fixed {
            assert!((v - 7.0).abs() < 1e-4, "{v}");
        }
    }

    #[test]
    fn volume_order_matches_slice_order() {
        let (_, ringing, rows, cols) = ringing_square();
        let mut volume = ringing.clone();
        volume.extend_from_slice(&ringing);
        let fixed = unring_volume(&volume, [rows, cols, 2], 1, [0, 1], Options::default());
        let slice = unring_slice(&ringing, rows, cols, Options::default());
        assert_eq!(&fixed[..rows * cols], &slice[..]);
        assert_eq!(&fixed[rows * cols..], &slice[..]);
    }
}

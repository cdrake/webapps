//! Fortran 77 semantics the port relies on: 1-based column-major arrays,
//! fixed-length blank-padded strings, COMPLEX arithmetic as gfortran emits it
//! under `-fcx-fortran-rules`, and the intrinsics LCModel calls.
//!
//! The rest of the crate is a line-for-line port of LCModel.f, so these types
//! let a statement such as `BASIST(J,JMETAB) = CMPLX(X, 0.)` read as
//! `self.basist[(j, jmetab)] = cmplx(x, 0.)`.

use std::fmt;
use std::ops::{Add, AddAssign, Div, DivAssign, Index, IndexMut, Mul, MulAssign, Neg, Sub, SubAssign};

// ---------------------------------------------------------------------------
// Errors. A Fortran STOP (normally reached through ERRMES with a fatal level)
// unwinds to the caller as `Err(Stop)`; every subprogram returns `R<T>`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Stop {
    /// Message written by ERRMES (or the reason for the STOP).
    pub message: String,
}

impl fmt::Display for Stop {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Stop {}

pub type R<T> = Result<T, Stop>;

pub fn stop<T>(message: impl Into<String>) -> R<T> {
    Err(Stop { message: message.into() })
}

// ---------------------------------------------------------------------------
// Arrays. Owned arrays for COMMON blocks and locals; borrowed views for dummy
// arguments (a Fortran actual argument `A(I,J)` becomes `a.tail_mut((i, j))`,
// the storage from that element to the end of the array).
// ---------------------------------------------------------------------------

/// One-dimensional array with Fortran bounds `lb:lb+n-1`, indexed by `i32`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FArr1<T> {
    pub lb: i32,
    pub data: Vec<T>,
}

impl<T: Clone + Default> FArr1<T> {
    /// `A(n)`.
    pub fn new(n: usize) -> Self {
        Self { lb: 1, data: vec![T::default(); n] }
    }
    /// `A(lb:ub)`.
    pub fn with_bounds(lb: i32, ub: i32) -> Self {
        let n = (ub - lb + 1).max(0) as usize;
        Self { lb, data: vec![T::default(); n] }
    }
    pub fn filled(n: usize, value: T) -> Self {
        Self { lb: 1, data: vec![value; n] }
    }
    pub fn fill(&mut self, value: T) {
        for v in self.data.iter_mut() {
            *v = value.clone();
        }
    }
}

impl<T> FArr1<T> {
    #[inline]
    fn off(&self, i: i32) -> usize {
        let k = i - self.lb;
        debug_assert!(k >= 0 && (k as usize) < self.data.len(), "index {i} outside {}:{}", self.lb, self.lb + self.data.len() as i32 - 1);
        k as usize
    }
    pub fn len(&self) -> usize {
        self.data.len()
    }
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
    /// Upper bound.
    pub fn ub(&self) -> i32 {
        self.lb + self.data.len() as i32 - 1
    }
    /// Storage from element `i` to the end, as passed by `CALL F(A(I))`.
    pub fn tail(&self, i: i32) -> &[T] {
        let k = self.off_tail(i);
        &self.data[k..]
    }
    pub fn tail_mut(&mut self, i: i32) -> &mut [T] {
        let k = self.off_tail(i);
        &mut self.data[k..]
    }
    fn off_tail(&self, i: i32) -> usize {
        let k = i - self.lb;
        assert!(k >= 0 && (k as usize) <= self.data.len());
        k as usize
    }
    pub fn as_slice(&self) -> &[T] {
        &self.data
    }
    pub fn as_mut_slice(&mut self) -> &mut [T] {
        &mut self.data
    }
}

impl<T> Index<i32> for FArr1<T> {
    type Output = T;
    #[inline]
    fn index(&self, i: i32) -> &T {
        let k = self.off(i);
        &self.data[k]
    }
}

impl<T> IndexMut<i32> for FArr1<T> {
    #[inline]
    fn index_mut(&mut self, i: i32) -> &mut T {
        let k = self.off(i);
        &mut self.data[k]
    }
}

/// Two-dimensional column-major array `A(lb1:ub1, lb2:ub2)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FArr2<T> {
    pub lb1: i32,
    pub n1: usize,
    pub lb2: i32,
    pub n2: usize,
    pub data: Vec<T>,
}

impl<T: Clone + Default> FArr2<T> {
    /// `A(n1, n2)`.
    pub fn new(n1: usize, n2: usize) -> Self {
        Self { lb1: 1, n1, lb2: 1, n2, data: vec![T::default(); n1 * n2] }
    }
    pub fn with_bounds(lb1: i32, ub1: i32, lb2: i32, ub2: i32) -> Self {
        let n1 = (ub1 - lb1 + 1).max(0) as usize;
        let n2 = (ub2 - lb2 + 1).max(0) as usize;
        Self { lb1, n1, lb2, n2, data: vec![T::default(); n1 * n2] }
    }
    pub fn fill(&mut self, value: T) {
        for v in self.data.iter_mut() {
            *v = value.clone();
        }
    }
}

impl<T> FArr2<T> {
    #[inline]
    pub fn offset(&self, i: i32, j: i32) -> usize {
        let a = i - self.lb1;
        let b = j - self.lb2;
        debug_assert!(a >= 0 && (a as usize) < self.n1, "first index {i} outside {}:{}", self.lb1, self.lb1 + self.n1 as i32 - 1);
        debug_assert!(b >= 0 && (b as usize) < self.n2, "second index {j} outside {}:{}", self.lb2, self.lb2 + self.n2 as i32 - 1);
        a as usize + self.n1 * b as usize
    }
    /// Storage from element `(i, j)` to the end of the array.
    pub fn tail(&self, (i, j): (i32, i32)) -> &[T] {
        let k = self.offset(i, j);
        &self.data[k..]
    }
    pub fn tail_mut(&mut self, (i, j): (i32, i32)) -> &mut [T] {
        let k = self.offset(i, j);
        &mut self.data[k..]
    }
    /// Column `j` (all of the first dimension).
    pub fn col(&self, j: i32) -> &[T] {
        let k = self.offset(self.lb1, j);
        &self.data[k..k + self.n1]
    }
    pub fn col_mut(&mut self, j: i32) -> &mut [T] {
        let k = self.offset(self.lb1, j);
        let n = self.n1;
        &mut self.data[k..k + n]
    }
    pub fn as_slice(&self) -> &[T] {
        &self.data
    }
    pub fn as_mut_slice(&mut self) -> &mut [T] {
        &mut self.data
    }
}

impl<T> Index<(i32, i32)> for FArr2<T> {
    type Output = T;
    #[inline]
    fn index(&self, (i, j): (i32, i32)) -> &T {
        let k = self.offset(i, j);
        &self.data[k]
    }
}

impl<T> IndexMut<(i32, i32)> for FArr2<T> {
    #[inline]
    fn index_mut(&mut self, (i, j): (i32, i32)) -> &mut T {
        let k = self.offset(i, j);
        &mut self.data[k]
    }
}

/// Three-dimensional column-major array.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FArr3<T> {
    pub lb: [i32; 3],
    pub n: [usize; 3],
    pub data: Vec<T>,
}

impl<T: Clone + Default> FArr3<T> {
    pub fn with_bounds(b: [(i32, i32); 3]) -> Self {
        let n = [
            (b[0].1 - b[0].0 + 1).max(0) as usize,
            (b[1].1 - b[1].0 + 1).max(0) as usize,
            (b[2].1 - b[2].0 + 1).max(0) as usize,
        ];
        Self { lb: [b[0].0, b[1].0, b[2].0], n, data: vec![T::default(); n[0] * n[1] * n[2]] }
    }
}

impl<T> FArr3<T> {
    #[inline]
    pub fn offset(&self, i: i32, j: i32, k: i32) -> usize {
        let a = (i - self.lb[0]) as usize;
        let b = (j - self.lb[1]) as usize;
        let c = (k - self.lb[2]) as usize;
        debug_assert!(a < self.n[0] && b < self.n[1] && c < self.n[2]);
        a + self.n[0] * (b + self.n[1] * c)
    }
}

impl<T> Index<(i32, i32, i32)> for FArr3<T> {
    type Output = T;
    fn index(&self, (i, j, k): (i32, i32, i32)) -> &T {
        let o = self.offset(i, j, k);
        &self.data[o]
    }
}

impl<T> IndexMut<(i32, i32, i32)> for FArr3<T> {
    fn index_mut(&mut self, (i, j, k): (i32, i32, i32)) -> &mut T {
        let o = self.offset(i, j, k);
        &mut self.data[o]
    }
}

/// Dummy-argument view `A(*)` / `A(N)` over a borrowed slice, 1-based
/// (or `lb`-based) indexing.
pub struct V1<'a, T> {
    pub lb: i32,
    pub s: &'a [T],
}

impl<'a, T> V1<'a, T> {
    pub fn new(s: &'a [T]) -> Self {
        Self { lb: 1, s }
    }
    pub fn with_lb(lb: i32, s: &'a [T]) -> Self {
        Self { lb, s }
    }
    pub fn tail(&self, i: i32) -> &[T] {
        &self.s[(i - self.lb) as usize..]
    }
}

impl<T> Index<i32> for V1<'_, T> {
    type Output = T;
    #[inline]
    fn index(&self, i: i32) -> &T {
        &self.s[(i - self.lb) as usize]
    }
}

pub struct V1Mut<'a, T> {
    pub lb: i32,
    pub s: &'a mut [T],
}

impl<'a, T> V1Mut<'a, T> {
    pub fn new(s: &'a mut [T]) -> Self {
        Self { lb: 1, s }
    }
    pub fn with_lb(lb: i32, s: &'a mut [T]) -> Self {
        Self { lb, s }
    }
    pub fn tail(&self, i: i32) -> &[T] {
        &self.s[(i - self.lb) as usize..]
    }
    pub fn tail_mut(&mut self, i: i32) -> &mut [T] {
        &mut self.s[(i - self.lb) as usize..]
    }
}

impl<T> Index<i32> for V1Mut<'_, T> {
    type Output = T;
    #[inline]
    fn index(&self, i: i32) -> &T {
        &self.s[(i - self.lb) as usize]
    }
}

impl<T> IndexMut<i32> for V1Mut<'_, T> {
    #[inline]
    fn index_mut(&mut self, i: i32) -> &mut T {
        &mut self.s[(i - self.lb) as usize]
    }
}

/// Dummy-argument view `A(LDA, *)` (column-major, leading dimension `ld`).
pub struct V2<'a, T> {
    pub ld: usize,
    pub lb1: i32,
    pub lb2: i32,
    pub s: &'a [T],
}

impl<'a, T> V2<'a, T> {
    pub fn new(s: &'a [T], ld: usize) -> Self {
        Self { ld, lb1: 1, lb2: 1, s }
    }
    pub fn with_bounds(s: &'a [T], lb1: i32, ld: usize, lb2: i32) -> Self {
        Self { ld, lb1, lb2, s }
    }
    #[inline]
    pub fn offset(&self, i: i32, j: i32) -> usize {
        (i - self.lb1) as usize + self.ld * (j - self.lb2) as usize
    }
    pub fn tail(&self, (i, j): (i32, i32)) -> &[T] {
        &self.s[self.offset(i, j)..]
    }
}

impl<T> Index<(i32, i32)> for V2<'_, T> {
    type Output = T;
    #[inline]
    fn index(&self, (i, j): (i32, i32)) -> &T {
        &self.s[self.offset(i, j)]
    }
}

pub struct V2Mut<'a, T> {
    pub ld: usize,
    pub lb1: i32,
    pub lb2: i32,
    pub s: &'a mut [T],
}

impl<'a, T> V2Mut<'a, T> {
    pub fn new(s: &'a mut [T], ld: usize) -> Self {
        Self { ld, lb1: 1, lb2: 1, s }
    }
    pub fn with_bounds(s: &'a mut [T], lb1: i32, ld: usize, lb2: i32) -> Self {
        Self { ld, lb1, lb2, s }
    }
    #[inline]
    pub fn offset(&self, i: i32, j: i32) -> usize {
        (i - self.lb1) as usize + self.ld * (j - self.lb2) as usize
    }
    pub fn tail(&self, (i, j): (i32, i32)) -> &[T] {
        &self.s[self.offset(i, j)..]
    }
    pub fn tail_mut(&mut self, (i, j): (i32, i32)) -> &mut [T] {
        let k = self.offset(i, j);
        &mut self.s[k..]
    }
}

impl<T> Index<(i32, i32)> for V2Mut<'_, T> {
    type Output = T;
    #[inline]
    fn index(&self, (i, j): (i32, i32)) -> &T {
        &self.s[self.offset(i, j)]
    }
}

impl<T> IndexMut<(i32, i32)> for V2Mut<'_, T> {
    #[inline]
    fn index_mut(&mut self, (i, j): (i32, i32)) -> &mut T {
        let k = self.offset(i, j);
        &mut self.s[k]
    }
}

// ---------------------------------------------------------------------------
// Complex numbers. gfortran compiles COMPLEX arithmetic inline under
// -fcx-fortran-rules: the textbook product and Smith's range-reduced
// quotient, with no NaN recovery. These reproduce those operation orders.
// ---------------------------------------------------------------------------

macro_rules! complex_type {
    ($name:ident, $t:ty) => {
        #[derive(Clone, Copy, Debug, Default, PartialEq)]
        #[repr(C)]
        pub struct $name {
            pub re: $t,
            pub im: $t,
        }

        impl $name {
            pub const ZERO: Self = Self { re: 0.0, im: 0.0 };
            #[inline]
            pub const fn new(re: $t, im: $t) -> Self {
                Self { re, im }
            }
            /// CONJG.
            #[inline]
            pub fn conj(self) -> Self {
                Self { re: self.re, im: -self.im }
            }
            /// ABS/CABS (hypot, as libm's cabs).
            #[inline]
            pub fn abs(self) -> $t {
                self.re.hypot(self.im)
            }
            /// CEXP, as libm's cexp for finite arguments.
            #[inline]
            pub fn exp(self) -> Self {
                let e = self.re.exp();
                let (s, c) = self.im.sin_cos();
                Self { re: e * c, im: e * s }
            }
            /// Multiply by a REAL (Fortran promotes the REAL to (r, 0); gfortran
            /// folds the zero terms away).
            #[inline]
            pub fn scale(self, r: $t) -> Self {
                Self { re: self.re * r, im: self.im * r }
            }
        }

        impl Add for $name {
            type Output = Self;
            #[inline]
            fn add(self, o: Self) -> Self {
                Self { re: self.re + o.re, im: self.im + o.im }
            }
        }
        impl Sub for $name {
            type Output = Self;
            #[inline]
            fn sub(self, o: Self) -> Self {
                Self { re: self.re - o.re, im: self.im - o.im }
            }
        }
        impl Mul for $name {
            type Output = Self;
            #[inline]
            fn mul(self, o: Self) -> Self {
                Self { re: self.re * o.re - self.im * o.im, im: self.re * o.im + self.im * o.re }
            }
        }
        impl Div for $name {
            type Output = Self;
            /// GCC expand_complex_div_wide (Smith's method).
            #[inline]
            fn div(self, o: Self) -> Self {
                let (ar, ai, br, bi) = (self.re, self.im, o.re, o.im);
                if br.abs() < bi.abs() {
                    let ratio = br / bi;
                    let div = br * ratio + bi;
                    let tr = ar * ratio + ai;
                    let ti = ai * ratio - ar;
                    Self { re: tr / div, im: ti / div }
                } else {
                    let ratio = bi / br;
                    let div = bi * ratio + br;
                    let tr = ai * ratio + ar;
                    let ti = ai - ar * ratio;
                    Self { re: tr / div, im: ti / div }
                }
            }
        }
        impl Neg for $name {
            type Output = Self;
            #[inline]
            fn neg(self) -> Self {
                Self { re: -self.re, im: -self.im }
            }
        }
        impl Mul<$t> for $name {
            type Output = Self;
            #[inline]
            fn mul(self, r: $t) -> Self {
                self.scale(r)
            }
        }
        impl Mul<$name> for $t {
            type Output = $name;
            #[inline]
            fn mul(self, c: $name) -> $name {
                $name { re: self * c.re, im: self * c.im }
            }
        }
        impl Div<$t> for $name {
            type Output = Self;
            /// COMPLEX / REAL: gfortran divides both parts by the real.
            #[inline]
            fn div(self, r: $t) -> Self {
                Self { re: self.re / r, im: self.im / r }
            }
        }
        impl Add<$t> for $name {
            type Output = Self;
            #[inline]
            fn add(self, r: $t) -> Self {
                Self { re: self.re + r, im: self.im }
            }
        }
        impl Sub<$t> for $name {
            type Output = Self;
            #[inline]
            fn sub(self, r: $t) -> Self {
                Self { re: self.re - r, im: self.im }
            }
        }
        impl AddAssign for $name {
            #[inline]
            fn add_assign(&mut self, o: Self) {
                *self = *self + o;
            }
        }
        impl SubAssign for $name {
            #[inline]
            fn sub_assign(&mut self, o: Self) {
                *self = *self - o;
            }
        }
        impl MulAssign for $name {
            #[inline]
            fn mul_assign(&mut self, o: Self) {
                *self = *self * o;
            }
        }
        impl MulAssign<$t> for $name {
            #[inline]
            fn mul_assign(&mut self, r: $t) {
                *self = *self * r;
            }
        }
        impl DivAssign for $name {
            #[inline]
            fn div_assign(&mut self, o: Self) {
                *self = *self / o;
            }
        }
        impl DivAssign<$t> for $name {
            #[inline]
            fn div_assign(&mut self, r: $t) {
                *self = *self / r;
            }
        }
    };
}

complex_type!(C32, f32);
complex_type!(C64, f64);

impl From<C32> for C64 {
    fn from(c: C32) -> Self {
        C64 { re: c.re as f64, im: c.im as f64 }
    }
}

/// A COMPLEX array seen as interleaved REALs (re, im, re, im, ...), as
/// FFTPACK receives it when a COMPLEX actual argument meets a REAL dummy.
pub fn c32_as_f32(c: &[C32]) -> &[f32] {
    // SAFETY: C32 is #[repr(C)] with two f32 fields and no padding.
    unsafe { std::slice::from_raw_parts(c.as_ptr() as *const f32, c.len() * 2) }
}

pub fn c32_as_f32_mut(c: &mut [C32]) -> &mut [f32] {
    // SAFETY: as above; the borrow is exclusive.
    unsafe { std::slice::from_raw_parts_mut(c.as_mut_ptr() as *mut f32, c.len() * 2) }
}

pub fn c64_as_f64(c: &[C64]) -> &[f64] {
    // SAFETY: C64 is #[repr(C)] with two f64 fields and no padding.
    unsafe { std::slice::from_raw_parts(c.as_ptr() as *const f64, c.len() * 2) }
}

pub fn c64_as_f64_mut(c: &mut [C64]) -> &mut [f64] {
    // SAFETY: as above; the borrow is exclusive.
    unsafe { std::slice::from_raw_parts_mut(c.as_mut_ptr() as *mut f64, c.len() * 2) }
}

/// CMPLX(re, im) for REAL arguments.
#[inline]
pub fn cmplx(re: f32, im: f32) -> C32 {
    C32 { re, im }
}

/// DCMPLX(re, im).
#[inline]
pub fn dcmplx(re: f64, im: f64) -> C64 {
    C64 { re, im }
}

/// CMPLX(z) of a COMPLEX*16 (rounds both parts to REAL).
#[inline]
pub fn sngl_c(z: C64) -> C32 {
    C32 { re: z.re as f32, im: z.im as f32 }
}

// ---------------------------------------------------------------------------
// Intrinsics.
// ---------------------------------------------------------------------------

/// NINT: nearest integer, halves away from zero.
#[inline]
pub fn nint(x: f32) -> i32 {
    x.round() as i32
}

/// IDNINT.
#[inline]
pub fn idnint(x: f64) -> i32 {
    x.round() as i32
}

/// INT/IFIX: truncation toward zero.
#[inline]
pub fn int(x: f32) -> i32 {
    x.trunc() as i32
}

/// IDINT.
#[inline]
pub fn idint(x: f64) -> i32 {
    x.trunc() as i32
}

/// SIGN(a, b) for REAL: |a| with the sign of b (gfortran honours -0.0).
#[inline]
pub fn sign(a: f32, b: f32) -> f32 {
    a.abs().copysign(b)
}

#[inline]
pub fn dsign(a: f64, b: f64) -> f64 {
    a.abs().copysign(b)
}

/// ISIGN.
#[inline]
pub fn isign(a: i32, b: i32) -> i32 {
    if b >= 0 {
        a.abs()
    } else {
        -a.abs()
    }
}

/// MOD for INTEGER (sign of the dividend, as Rust's %).
#[inline]
pub fn imod(a: i32, b: i32) -> i32 {
    a % b
}

/// AMOD/MOD for REAL: a - int(a/b)*b.
#[inline]
pub fn amod(a: f32, b: f32) -> f32 {
    a % b
}

/// Integer power I**J (Fortran semantics for negative exponents).
pub fn ipow(base: i32, exp: i32) -> i32 {
    if exp < 0 {
        return match base {
            1 => 1,
            -1 => {
                if exp % 2 == 0 {
                    1
                } else {
                    -1
                }
            }
            _ => 0,
        };
    }
    base.wrapping_pow(exp as u32)
}

/// X**I for REAL base, INTEGER exponent (gfortran uses __builtin_powi).
#[inline]
pub fn powi(x: f32, i: i32) -> f32 {
    x.powi(i)
}

#[inline]
pub fn dpowi(x: f64, i: i32) -> f64 {
    x.powi(i)
}

/// ALOG10.
#[inline]
pub fn alog10(x: f32) -> f32 {
    x.log10()
}

/// FLOAT/REAL of an INTEGER.
#[inline]
pub fn float(i: i32) -> f32 {
    i as f32
}

/// DBLE/DFLOAT of an INTEGER.
#[inline]
pub fn dfloat(i: i32) -> f64 {
    i as f64
}

/// A REAL literal such as `.1` used inside a DOUBLE PRECISION expression:
/// Fortran evaluates the literal in single precision first.
#[inline]
pub fn r2d(x: f32) -> f64 {
    x as f64
}

/// `DO J = A, B, S`: the Fortran trip count max(0, (B-A+S)/S) is fixed on
/// entry. After a completed loop the variable holds `a + trips * s`
/// (see `fdo_end`).
pub fn fdo(a: i32, b: i32, s: i32) -> impl Iterator<Item = i32> {
    assert!(s != 0, "DO step of zero");
    let trips = ((b - a + s) / s).max(0);
    (0..trips).map(move |k| a + k * s)
}

/// Value of the DO variable after `DO J = A, B, S` completes.
pub fn fdo_end(a: i32, b: i32, s: i32) -> i32 {
    let trips = ((b - a + s) / s).max(0);
    a + trips * s
}

// ---------------------------------------------------------------------------
// CHARACTER*n: fixed-length, blank-padded. Comparisons ignore trailing blanks
// as in Fortran. Byte strings, since LCModel's text is ASCII.
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct FStr {
    bytes: Vec<u8>,
}

impl Default for FStr {
    fn default() -> Self {
        FStr { bytes: Vec::new() }
    }
}

impl fmt::Debug for FStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.as_str())
    }
}

impl fmt::Display for FStr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_str())
    }
}

impl FStr {
    /// A blank CHARACTER*len.
    pub fn blank(len: usize) -> Self {
        FStr { bytes: vec![b' '; len] }
    }
    /// A CHARACTER*len holding `s` (truncated or blank-padded).
    pub fn new(len: usize, s: &str) -> Self {
        let mut f = FStr::blank(len);
        f.set(s);
        f
    }
    /// A string whose length is exactly `s` (a literal or expression result).
    pub fn lit(s: &str) -> Self {
        FStr { bytes: s.as_bytes().to_vec() }
    }
    pub fn from_bytes(b: &[u8]) -> Self {
        FStr { bytes: b.to_vec() }
    }
    /// LEN.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// Full contents, including trailing blanks.
    pub fn as_str(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    /// Contents without trailing blanks.
    pub fn trim(&self) -> String {
        String::from_utf8_lossy(&self.bytes[..self.len_trim()]).into_owned()
    }
    /// Length without trailing blanks (LCModel's ILEN, Fortran LEN_TRIM).
    pub fn len_trim(&self) -> usize {
        let mut n = self.bytes.len();
        while n > 0 && (self.bytes[n - 1] == b' ' || self.bytes[n - 1] == 0) {
            n -= 1;
        }
        n
    }
    /// True when all blank (`CH .EQ. ' '`).
    pub fn is_blank(&self) -> bool {
        self.len_trim() == 0
    }
    /// Assignment `V = s`: truncate or blank-pad to LEN(V).
    pub fn set(&mut self, s: &str) {
        self.set_bytes(s.as_bytes());
    }
    pub fn set_f(&mut self, s: &FStr) {
        let b = s.bytes.clone();
        self.set_bytes(&b);
    }
    pub fn set_bytes(&mut self, s: &[u8]) {
        let n = self.bytes.len();
        for k in 0..n {
            self.bytes[k] = if k < s.len() { s[k] } else { b' ' };
        }
    }
    /// Substring `V(i:j)` (1-based, inclusive).
    pub fn sub(&self, i: i32, j: i32) -> FStr {
        if j < i {
            return FStr::lit("");
        }
        let a = (i - 1) as usize;
        let b = (j as usize).min(self.bytes.len());
        FStr { bytes: self.bytes[a..b].to_vec() }
    }
    /// `V(i:)`.
    pub fn sub_from(&self, i: i32) -> FStr {
        self.sub(i, self.bytes.len() as i32)
    }
    /// `V(i:j) = s`: truncate or blank-pad into the substring.
    pub fn set_sub(&mut self, i: i32, j: i32, s: &str) {
        self.set_sub_bytes(i, j, s.as_bytes());
    }
    pub fn set_sub_f(&mut self, i: i32, j: i32, s: &FStr) {
        let b = s.bytes.clone();
        self.set_sub_bytes(i, j, &b);
    }
    pub fn set_sub_bytes(&mut self, i: i32, j: i32, s: &[u8]) {
        if j < i {
            return;
        }
        let a = (i - 1) as usize;
        let b = (j as usize).min(self.bytes.len());
        for (k, pos) in (a..b).enumerate() {
            self.bytes[pos] = if k < s.len() { s[k] } else { b' ' };
        }
    }
    /// Single character `V(i:i)` as a byte.
    pub fn at(&self, i: i32) -> u8 {
        self.bytes[(i - 1) as usize]
    }
    pub fn set_at(&mut self, i: i32, c: u8) {
        self.bytes[(i - 1) as usize] = c;
    }
    /// Concatenation `A // B`.
    pub fn cat(&self, o: &FStr) -> FStr {
        let mut b = self.bytes.clone();
        b.extend_from_slice(&o.bytes);
        FStr { bytes: b }
    }
    pub fn cat_str(&self, o: &str) -> FStr {
        let mut b = self.bytes.clone();
        b.extend_from_slice(o.as_bytes());
        FStr { bytes: b }
    }
    /// INDEX(V, s): 1-based position of the first occurrence, 0 if none.
    pub fn index(&self, s: &str) -> i32 {
        index_bytes(&self.bytes, s.as_bytes())
    }
    pub fn index_f(&self, s: &FStr) -> i32 {
        index_bytes(&self.bytes, &s.bytes)
    }
    /// Fortran `.EQ.` against a literal: shorter operand padded with blanks.
    pub fn eq_str(&self, s: &str) -> bool {
        fortran_eq(&self.bytes, s.as_bytes())
    }
    pub fn eq_f(&self, s: &FStr) -> bool {
        fortran_eq(&self.bytes, &s.bytes)
    }
}

fn index_bytes(h: &[u8], n: &[u8]) -> i32 {
    if n.is_empty() {
        return 1;
    }
    if n.len() > h.len() {
        return 0;
    }
    for k in 0..=(h.len() - n.len()) {
        if &h[k..k + n.len()] == n {
            return k as i32 + 1;
        }
    }
    0
}

/// Fortran character equality: the shorter operand is blank-padded.
pub fn fortran_eq(a: &[u8], b: &[u8]) -> bool {
    let n = a.len().max(b.len());
    for k in 0..n {
        let x = if k < a.len() { a[k] } else { b' ' };
        let y = if k < b.len() { b[k] } else { b' ' };
        if x != y {
            return false;
        }
    }
    true
}

/// Fortran character ordering (LLT/LGT and `.LT.` on CHARACTER): blank-padded
/// comparison of ASCII codes.
pub fn fortran_cmp(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for k in 0..n {
        let x = if k < a.len() { a[k] } else { b' ' };
        let y = if k < b.len() { b[k] } else { b' ' };
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

impl PartialEq<str> for FStr {
    fn eq(&self, o: &str) -> bool {
        self.eq_str(o)
    }
}

impl PartialEq<&str> for FStr {
    fn eq(&self, o: &&str) -> bool {
        self.eq_str(o)
    }
}

/// An array `CHARACTER*len A(n)` (every element fixed-length).
pub fn fstr_arr1(n: usize, len: usize) -> FArr1<FStr> {
    FArr1 { lb: 1, data: vec![FStr::blank(len); n] }
}

pub fn fstr_arr2(n1: usize, n2: usize, len: usize) -> FArr2<FStr> {
    FArr2 { lb1: 1, n1, lb2: 1, n2, data: vec![FStr::blank(len); n1 * n2] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrays_are_one_based_column_major() {
        let mut a: FArr2<i32> = FArr2::new(3, 2);
        a[(1, 1)] = 1;
        a[(3, 1)] = 3;
        a[(1, 2)] = 4;
        assert_eq!(a.data, vec![1, 0, 3, 4, 0, 0]);
        assert_eq!(a.tail((3, 1))[1], 4);
        let mut b: FArr1<f32> = FArr1::with_bounds(0, 4);
        b[0] = 2.0;
        b[4] = 5.0;
        assert_eq!(b.data, vec![2.0, 0.0, 0.0, 0.0, 5.0]);
    }

    #[test]
    fn strings_pad_truncate_and_compare_like_fortran() {
        let mut s = FStr::blank(6);
        s.set("Lip13ab");
        assert_eq!(s.as_str(), "Lip13a");
        s.set("Cr");
        assert_eq!(s.as_str(), "Cr    ");
        assert!(s.eq_str("Cr"));
        assert!(s == "Cr  ");
        assert_eq!(s.len_trim(), 2);
        assert_eq!(FStr::lit("NAA+NAAG").index("+"), 4);
        let mut t = FStr::new(8, "abcdefgh");
        t.set_sub(3, 5, "X");
        assert_eq!(t.as_str(), "abX  fgh");
        assert_eq!(t.sub(1, 2).as_str(), "ab");
    }

    #[test]
    fn complex_division_matches_smith() {
        let a = cmplx(1.0, 2.0);
        let b = cmplx(3.0, -4.0);
        let q = a / b;
        assert!((q.re - (-0.2)).abs() < 1e-7 && (q.im - 0.4).abs() < 1e-7);
        assert_eq!(nint(2.5), 3);
        assert_eq!(nint(-2.5), -3);
        assert_eq!(int(-2.7), -2);
        assert_eq!(sign(3.0, -0.0), -3.0);
        assert_eq!(ipow(2, 10), 1024);
    }
}

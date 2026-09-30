//! Helpers shared by the readers: bounds-checked byte access, MATLAB/Octave
//! array semantics (colon ranges, squeeze, permute) and the FID-A axes.

use crate::spectra::{Dims, Flags, Spectra};
use num_complex::Complex64;

pub type Res<T> = Result<T, String>;

/// Bounds-checked little/big-endian reads from a byte slice.
#[derive(Clone, Copy)]
pub struct Bytes<'a> {
    pub b: &'a [u8],
    pub what: &'a str,
}

impl<'a> Bytes<'a> {
    pub fn new(b: &'a [u8], what: &'a str) -> Self {
        Bytes { b, what }
    }

    pub fn len(&self) -> usize {
        self.b.len()
    }

    pub fn slice(&self, off: usize, n: usize) -> Res<&'a [u8]> {
        match off.checked_add(n) {
            Some(end) if end <= self.b.len() => Ok(&self.b[off..end]),
            _ => Err(format!(
                "This {} file is truncated or corrupt: it ends at byte {} but data are expected up to byte {}.",
                self.what,
                self.b.len(),
                off.saturating_add(n)
            )),
        }
    }

    fn arr<const N: usize>(&self, off: usize) -> Res<[u8; N]> {
        let s = self.slice(off, N)?;
        let mut a = [0u8; N];
        a.copy_from_slice(s);
        Ok(a)
    }

    pub fn u8(&self, off: usize) -> Res<u8> {
        Ok(self.arr::<1>(off)?[0])
    }
    pub fn u16le(&self, off: usize) -> Res<u16> {
        Ok(u16::from_le_bytes(self.arr(off)?))
    }
    pub fn i16le(&self, off: usize) -> Res<i16> {
        Ok(i16::from_le_bytes(self.arr(off)?))
    }
    pub fn u32le(&self, off: usize) -> Res<u32> {
        Ok(u32::from_le_bytes(self.arr(off)?))
    }
    pub fn i32le(&self, off: usize) -> Res<i32> {
        Ok(i32::from_le_bytes(self.arr(off)?))
    }
    pub fn u64le(&self, off: usize) -> Res<u64> {
        Ok(u64::from_le_bytes(self.arr(off)?))
    }
    pub fn i64le(&self, off: usize) -> Res<i64> {
        Ok(i64::from_le_bytes(self.arr(off)?))
    }
    pub fn f32le(&self, off: usize) -> Res<f32> {
        Ok(f32::from_le_bytes(self.arr(off)?))
    }
    pub fn f64le(&self, off: usize) -> Res<f64> {
        Ok(f64::from_le_bytes(self.arr(off)?))
    }
    pub fn f32be(&self, off: usize) -> Res<f32> {
        Ok(f32::from_be_bytes(self.arr(off)?))
    }
}

/// Octave's tolerant floor (Hagerty's FL5), as used for range lengths.
fn xtfloor(x: f64, ct: f64) -> f64 {
    let q = if x < 0.0 { 1.0 - ct } else { 1.0 };
    let rmax = q / (2.0 - ct);
    let mut t1 = 1.0 + x.floor();
    t1 = (ct / q) * if t1 < 0.0 { -t1 } else { t1 };
    t1 = if rmax < t1 { rmax } else { t1 };
    t1 = if ct > t1 { ct } else { t1 };
    t1 = (x + t1).floor();
    if x <= 0.0 || (t1 - x) < rmax {
        t1
    } else {
        t1 - 1.0
    }
}

fn xteq(u: f64, v: f64) -> bool {
    let ct = 3.0 * f64::EPSILON;
    let (tu, tv) = (u.abs(), v.abs());
    (u - v).abs() < (if tu > tv { tu } else { tv }) * ct
}

/// Octave `base:inc:limit` (element count and values as Octave's range class).
pub fn octave_range(base: f64, inc: f64, limit: f64) -> Vec<f64> {
    if !(base.is_finite() && inc.is_finite() && limit.is_finite()) {
        return Vec::new();
    }
    if inc == 0.0 || (limit > base && inc < 0.0) || (limit < base && inc > 0.0) {
        return Vec::new();
    }
    let ct = 3.0 * f64::EPSILON;
    let tmp = xtfloor((limit - base + inc) / inc, ct);
    let mut n: i64 = if tmp > 0.0 { tmp as i64 } else { 0 };
    if !xteq(base + (n - 1) as f64 * inc, limit) {
        if xteq(base + (n - 2) as f64 * inc, limit) {
            n -= 1;
        } else if xteq(base + n as f64 * inc, limit) {
            n += 1;
        }
    }
    if n <= 0 || n > 100_000_000 {
        return Vec::new();
    }
    let n = n as usize;
    let mut fin = if n <= 1 { base } else { base + (n - 1) as f64 * inc };
    if n > 1 && ((inc > 0.0 && fin >= limit) || (inc < 0.0 && fin <= limit)) {
        fin = limit;
    }
    let all_int = base.fract() == 0.0 && inc.fract() == 0.0;
    if all_int {
        fin = fin.round();
    }
    (0..n)
        .map(|i| {
            if i == 0 {
                base
            } else if i < n - 1 {
                base + i as f64 * inc
            } else {
                fin
            }
        })
        .collect()
}

/// FID-A's frequency axis: `(-sw/2)+(sw/(2n)) : sw/n : (sw/2)-(sw/(2n))`.
pub fn freq_axis(sw: f64, n: usize) -> Vec<f64> {
    let n = n as f64;
    octave_range((-sw / 2.0) + (sw / (2.0 * n)), sw / n, (sw / 2.0) - (sw / (2.0 * n)))
}

/// `ppm = -f/(Bo*gamma) + offset` (`sign` = -1) or `f/(Bo*gamma) + offset` (`sign` = +1).
pub fn ppm_axis(sw: f64, n: usize, bo_gamma: f64, sign: f64, offset: f64) -> Vec<f64> {
    freq_axis(sw, n)
        .into_iter()
        .map(|f| (if sign < 0.0 { -f } else { f }) / bo_gamma + offset)
        .collect()
}

/// `t = 0:dwelltime:(n-1)*dwelltime`.
pub fn time_axis(dwelltime: f64, n: usize) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    octave_range(0.0, dwelltime, (n as f64 - 1.0) * dwelltime)
}

/// A column-major N-d complex array with MATLAB semantics.
#[derive(Clone, Debug, Default)]
pub struct NdArray {
    pub data: Vec<Complex64>,
    pub shape: Vec<usize>,
}

impl NdArray {
    pub fn new(data: Vec<Complex64>, shape: Vec<usize>) -> Self {
        let mut a = NdArray { data, shape };
        a.trim();
        a
    }

    /// Drop trailing singleton dimensions (keep at least 2), as MATLAB `size`.
    pub fn trim(&mut self) {
        while self.shape.len() > 2 && *self.shape.last().unwrap() == 1 {
            self.shape.pop();
        }
        while self.shape.len() < 2 {
            self.shape.push(1);
        }
    }

    pub fn ndims(&self) -> usize {
        self.shape.len()
    }

    pub fn dim(&self, k: usize) -> usize {
        self.shape.get(k).copied().unwrap_or(1)
    }

    /// MATLAB `squeeze`: remove singleton dimensions (2-D arrays are unchanged).
    pub fn squeeze(mut self) -> Self {
        if self.shape.len() > 2 {
            let s: Vec<usize> = self.shape.iter().copied().filter(|&d| d != 1).collect();
            self.shape = s;
            if self.shape.len() == 1 {
                // MATLAB: a squeezed N-d array with one non-singleton is a column
                self.shape.push(1);
            }
            self.trim();
        }
        self
    }

    /// MATLAB `permute(A, order)` with a 1-based order.
    pub fn permute(self, order: &[usize]) -> Res<Self> {
        let n = order.len();
        let mut seen = vec![false; n];
        for &o in order {
            if o == 0 || o > n || seen[o - 1] {
                return Err("internal error: invalid dimension order".into());
            }
            seen[o - 1] = true;
        }
        if n < self.shape.len() {
            return Err("internal error: dimension order shorter than the data".into());
        }
        let mut src_shape = self.shape.clone();
        src_shape.resize(n, 1);
        let new_shape: Vec<usize> = order.iter().map(|&o| src_shape[o - 1]).collect();
        if order.iter().enumerate().all(|(i, &o)| o == i + 1) {
            return Ok(NdArray::new(self.data, new_shape));
        }
        let mut src_stride = vec![1usize; n];
        for k in 1..n {
            src_stride[k] = src_stride[k - 1] * src_shape[k - 1];
        }
        let strides: Vec<usize> = order.iter().map(|&o| src_stride[o - 1]).collect();
        let total: usize = new_shape.iter().product();
        let mut out = Vec::with_capacity(total);
        let mut idx = vec![0usize; n];
        let mut off = 0usize;
        for _ in 0..total {
            out.push(self.data[off]);
            for k in 0..n {
                idx[k] += 1;
                off += strides[k];
                if idx[k] < new_shape[k] {
                    break;
                }
                off -= strides[k] * new_shape[k];
                idx[k] = 0;
            }
        }
        Ok(NdArray::new(out, new_shape))
    }

    /// Select along dimension `d` (0-based) the 0-based indices `ix`.
    pub fn select(&self, d: usize, ix: &[usize]) -> Res<Self> {
        let mut shape = self.shape.clone();
        if d >= shape.len() {
            shape.resize(d + 1, 1);
        }
        let inner: usize = shape[..d].iter().product();
        let len = shape[d];
        let outer: usize = shape[d + 1..].iter().product();
        if ix.iter().any(|&i| i >= len) {
            return Err("internal error: index exceeds the data dimensions".into());
        }
        let mut out = Vec::with_capacity(inner * ix.len() * outer);
        for o in 0..outer {
            for &i in ix {
                let s = (o * len + i) * inner;
                out.extend_from_slice(&self.data[s..s + inner]);
            }
        }
        shape[d] = ix.len();
        Ok(NdArray::new(out, shape))
    }
}

/// FID-A's default flags for a freshly loaded structure.
pub fn fresh_flags() -> Flags {
    Flags {
        writtentostruct: true,
        gotparams: true,
        ..Flags::default()
    }
}

/// FID-A `isFourSteps`.
pub fn four_steps(sz: &[usize], dims: &Dims) -> bool {
    dims.sub_specs != 0 && sz.get(dims.sub_specs - 1).copied() == Some(4)
}

/// Assemble a `Spectra` from an array and its header; averages/subspecs are
/// set by the caller.
pub fn spectra_from(a: NdArray, dims: Dims) -> Spectra {
    let sz = a.shape.clone();
    Spectra {
        fids: a.data,
        sz,
        dims,
        nucleus: "1H".into(),
        flags: fresh_flags(),
        ..Spectra::default()
    }
}

/// The averages/rawAverages/subspecs/rawSubspecs block most FID-A readers share.
pub fn standard_counts(sz: &[usize], dims: &Dims) -> (usize, usize, usize, usize) {
    let g = |d: usize| sz.get(d - 1).copied().unwrap_or(1);
    let (averages, raw_averages) = if dims.sub_specs != 0 {
        if dims.averages != 0 {
            let a = g(dims.averages) * g(dims.sub_specs);
            (a, a)
        } else {
            (g(dims.sub_specs), 1)
        }
    } else if dims.averages != 0 {
        (g(dims.averages), g(dims.averages))
    } else {
        (1, 1)
    };
    let subspecs = if dims.sub_specs != 0 { g(dims.sub_specs) } else { 1 };
    (averages, raw_averages, subspecs, subspecs)
}

/// MATLAB `str2double` on a header value: trims whitespace, NaN when not a number.
pub fn str2double(s: &str) -> f64 {
    let t = s.trim();
    parse_number(t).unwrap_or(f64::NAN)
}

/// One real number as MATLAB/Octave writes it (decimal, exponent, Inf, NaN).
pub fn parse_number(t: &str) -> Option<f64> {
    let t = t.trim();
    if t.is_empty() {
        return None;
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    match body {
        "Inf" | "inf" => return Some(sign * f64::INFINITY),
        "NaN" | "nan" => return Some(f64::NAN),
        _ => {}
    }
    if body.len() > 2 && (body.starts_with("0x") || body.starts_with("0X")) {
        return u64::from_str_radix(&body[2..], 16).ok().map(|v| sign * v as f64);
    }
    // Rust's float grammar is stricter than we need (no 'd' exponents), which is fine.
    let ok = body.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !ok || !body.bytes().next().map(|c| c.is_ascii_digit() || c == b'.').unwrap_or(false) {
        return None;
    }
    body.parse::<f64>().ok().map(|v| sign * v)
}

/// MATLAB `str2num` on a header value holding one or more numbers separated by
/// whitespace or commas; `None` when any token is not a number.
pub fn str2num(s: &str) -> Option<Vec<f64>> {
    let mut out = Vec::new();
    for tok in s.split(|c: char| c.is_whitespace() || c == ',' || c == ';') {
        if tok.is_empty() {
            continue;
        }
        out.push(parse_number(tok)?);
    }
    Some(out)
}

/// First `str2num` value, or an actionable error naming the field.
pub fn num_field(s: &str, field: &str, what: &str) -> Res<f64> {
    match str2num(s) {
        Some(v) if !v.is_empty() => Ok(v[0]),
        _ => Err(format!("The {what} header field {field} is not a number ({:?}).", s.trim())),
    }
}

/// Case-sensitive substring search, as MATLAB `strfind`/`contains`.
pub fn has(s: &str, pat: &str) -> bool {
    s.contains(pat)
}

/// Read a gzip stream if the bytes start with the gzip magic.
pub fn maybe_gunzip(b: &[u8]) -> Res<std::borrow::Cow<'_, [u8]>> {
    if b.len() >= 2 && b[0] == 0x1f && b[1] == 0x8b {
        use std::io::Read;
        let mut out = Vec::new();
        flate2::read::MultiGzDecoder::new(b)
            .read_to_end(&mut out)
            .map_err(|e| format!("This file looks gzip-compressed but could not be decompressed: {e}"))?;
        Ok(std::borrow::Cow::Owned(out))
    } else {
        Ok(std::borrow::Cow::Borrowed(b))
    }
}

/// Split text into lines the way MATLAB `fgets` returns them (keeping the
/// terminating `\n`).
pub fn fgets_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_match_octave() {
        let r = octave_range(0.0, 0.1, 0.3);
        assert_eq!(r.len(), 4);
        assert_eq!(r[3], 0.3);
        assert_eq!(r[2], 2.0 * 0.1);
        assert_eq!(octave_range(1.0, 1.0, 0.0).len(), 0);
        assert_eq!(octave_range(1.0, 2.0, 7.0), vec![1.0, 3.0, 5.0, 7.0]);
    }

    #[test]
    fn permute_and_squeeze() {
        let d: Vec<Complex64> = (0..24).map(|k| Complex64::new(k as f64, 0.0)).collect();
        let a = NdArray::new(d, vec![2, 3, 4]);
        let p = a.clone().permute(&[1, 3, 2]).unwrap();
        assert_eq!(p.shape, vec![2, 4, 3]);
        // p(1,2,1) = a(1,1,2) = 6
        assert_eq!(p.data[2].re, 6.0);
        let s = NdArray::new(vec![Complex64::default(); 6], vec![1, 6, 1]).squeeze();
        assert_eq!(s.shape, vec![1, 6]);
        let s = NdArray::new(vec![Complex64::default(); 6], vec![1, 1, 6]).squeeze();
        assert_eq!(s.shape, vec![6, 1]);
        let sel = a.select(2, &[1, 3]).unwrap();
        assert_eq!(sel.shape, vec![2, 3, 2]);
        assert_eq!(sel.data[0].re, 6.0);
    }

    #[test]
    fn numbers() {
        assert_eq!(parse_number("0x1a"), Some(26.0));
        assert_eq!(parse_number(" -2.5e3 "), Some(-2500.0));
        assert_eq!(parse_number("1H"), None);
        assert_eq!(str2num(" 1 2,3\r\n"), Some(vec![1.0, 2.0, 3.0]));
        assert!(str2double("abc").is_nan());
    }
}

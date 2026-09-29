//! A Fortran FORMAT interpreter with gfortran's output conventions, for the
//! formatted WRITE and READ statements of LCModel.f.
//!
//! `write_fmt("(1X, 1PE9.2, I4)", &[FVal::R(x), FVal::I(n)])` returns the
//! records the statement would produce (one `String` per record).
//! `read_fmt` does the reverse over a sequence of input records.

use crate::fortran::{FStr, C32};

/// One item of a Fortran I/O list.
#[derive(Clone, Debug)]
pub enum FVal {
    I(i32),
    R(f32),
    D(f64),
    L(bool),
    S(String),
    /// A COMPLEX item consumes two edit descriptors (real then imaginary).
    C(C32),
}

impl From<i32> for FVal {
    fn from(v: i32) -> Self {
        FVal::I(v)
    }
}
impl From<f32> for FVal {
    fn from(v: f32) -> Self {
        FVal::R(v)
    }
}
impl From<f64> for FVal {
    fn from(v: f64) -> Self {
        FVal::D(v)
    }
}
impl From<bool> for FVal {
    fn from(v: bool) -> Self {
        FVal::L(v)
    }
}
impl From<&str> for FVal {
    fn from(v: &str) -> Self {
        FVal::S(v.to_string())
    }
}
impl From<String> for FVal {
    fn from(v: String) -> Self {
        FVal::S(v)
    }
}
impl From<&FStr> for FVal {
    fn from(v: &FStr) -> Self {
        FVal::S(v.as_str())
    }
}
impl From<FStr> for FVal {
    fn from(v: FStr) -> Self {
        FVal::S(v.as_str())
    }
}
impl From<C32> for FVal {
    fn from(v: C32) -> Self {
        FVal::C(v)
    }
}

/// Build an I/O list: `fv![x, n, "text", &name]`.
#[macro_export]
macro_rules! fv {
    ($($e:expr),* $(,)?) => {
        vec![$($crate::format::FVal::from($e)),*]
    };
}

#[derive(Clone, Debug, PartialEq)]
enum Item {
    /// Repeatable data descriptor.
    Data(Desc),
    /// Literal text ('...' or nH...).
    Lit(String),
    /// nX
    X(usize),
    /// Tn, TLn, TRn
    T(usize),
    TL(usize),
    TR(usize),
    /// Record separator.
    Slash,
    /// Colon: stop if no items remain.
    Colon,
    /// kP scale factor.
    P(i32),
    /// BN/BZ/S/SP/SS: accepted and ignored except SP.
    SignPlus(bool),
    Group(usize, Vec<Item>),
    /// A repeated data descriptor such as 3I5 (not a group for reversion).
    Rep(usize, Desc),
}

#[derive(Clone, Debug, PartialEq)]
enum Desc {
    I(usize, Option<usize>),
    F(usize, usize),
    E(usize, usize, Option<usize>),
    /// ES
    ES(usize, usize, Option<usize>),
    D(usize, usize),
    G(usize, usize, Option<usize>),
    /// A or Aw
    A(Option<usize>),
    L(usize),
}

fn parse(fmt: &str) -> Vec<Item> {
    let s: Vec<char> = fmt.chars().collect();
    let mut pos = 0;
    // Skip to the opening parenthesis.
    while pos < s.len() && s[pos] != '(' {
        pos += 1;
    }
    if pos < s.len() {
        pos += 1;
    }
    parse_list(&s, &mut pos)
}

fn skip_ws(s: &[char], pos: &mut usize) {
    while *pos < s.len() && (s[*pos] == ' ' || s[*pos] == '\t' || s[*pos] == '\n') {
        *pos += 1;
    }
}

fn read_uint(s: &[char], pos: &mut usize) -> Option<usize> {
    skip_ws(s, pos);
    let start = *pos;
    while *pos < s.len() && s[*pos].is_ascii_digit() {
        *pos += 1;
    }
    if *pos == start {
        None
    } else {
        Some(s[start..*pos].iter().collect::<String>().parse().unwrap())
    }
}

fn parse_list(s: &[char], pos: &mut usize) -> Vec<Item> {
    let mut items = Vec::new();
    loop {
        skip_ws(s, pos);
        if *pos >= s.len() {
            break;
        }
        let c = s[*pos];
        if c == ')' {
            *pos += 1;
            break;
        }
        if c == ',' {
            *pos += 1;
            continue;
        }
        if c == '/' {
            *pos += 1;
            items.push(Item::Slash);
            continue;
        }
        if c == ':' {
            *pos += 1;
            items.push(Item::Colon);
            continue;
        }
        if c == '\'' || c == '"' {
            let q = c;
            *pos += 1;
            let mut lit = String::new();
            while *pos < s.len() {
                if s[*pos] == q {
                    if *pos + 1 < s.len() && s[*pos + 1] == q {
                        lit.push(q);
                        *pos += 2;
                        continue;
                    }
                    *pos += 1;
                    break;
                }
                lit.push(s[*pos]);
                *pos += 1;
            }
            items.push(Item::Lit(lit));
            continue;
        }
        // Optional sign for kP.
        let mut neg = false;
        if c == '-' || c == '+' {
            neg = c == '-';
            *pos += 1;
        }
        let count = read_uint(s, pos);
        skip_ws(s, pos);
        if *pos >= s.len() {
            break;
        }
        let c = s[*pos].to_ascii_uppercase();
        match c {
            '(' => {
                *pos += 1;
                let inner = parse_list(s, pos);
                items.push(Item::Group(count.unwrap_or(1), inner));
            }
            'P' => {
                *pos += 1;
                let k = count.unwrap_or(0) as i32;
                items.push(Item::P(if neg { -k } else { k }));
            }
            'X' => {
                *pos += 1;
                items.push(Item::X(count.unwrap_or(1)));
            }
            'H' => {
                *pos += 1;
                let n = count.unwrap_or(0);
                let lit: String = s[*pos..(*pos + n).min(s.len())].iter().collect();
                *pos += n;
                items.push(Item::Lit(lit));
            }
            'T' => {
                *pos += 1;
                let next = if *pos < s.len() { s[*pos].to_ascii_uppercase() } else { ' ' };
                if next == 'L' {
                    *pos += 1;
                    items.push(Item::TL(read_uint(s, pos).unwrap_or(1)));
                } else if next == 'R' {
                    *pos += 1;
                    items.push(Item::TR(read_uint(s, pos).unwrap_or(1)));
                } else {
                    items.push(Item::T(read_uint(s, pos).unwrap_or(1)));
                }
            }
            'B' => {
                // BN / BZ
                *pos += 2;
            }
            'S' => {
                *pos += 1;
                let next = if *pos < s.len() { s[*pos].to_ascii_uppercase() } else { ' ' };
                if next == 'P' {
                    *pos += 1;
                    items.push(Item::SignPlus(true));
                } else if next == 'S' {
                    *pos += 1;
                    items.push(Item::SignPlus(false));
                } else {
                    items.push(Item::SignPlus(false));
                }
            }
            _ => {
                let desc = parse_desc(s, pos);
                let item = Item::Data(desc);
                match count {
                    Some(n) if n != 1 => {
                        if let Item::Data(d) = item {
                            items.push(Item::Rep(n, d));
                        }
                    }
                    _ => items.push(item),
                }
            }
        }
    }
    items
}

fn parse_desc(s: &[char], pos: &mut usize) -> Desc {
    let c = s[*pos].to_ascii_uppercase();
    *pos += 1;
    let mut es = false;
    if c == 'E' && *pos < s.len() && s[*pos].to_ascii_uppercase() == 'S' {
        es = true;
        *pos += 1;
    }
    let w = read_uint(s, pos);
    let mut d = None;
    let mut e = None;
    skip_ws(s, pos);
    if *pos < s.len() && s[*pos] == '.' {
        *pos += 1;
        d = read_uint(s, pos);
    }
    skip_ws(s, pos);
    if (c == 'E' || c == 'G') && *pos < s.len() && s[*pos].to_ascii_uppercase() == 'E' {
        // Ew.dEe
        let save = *pos;
        *pos += 1;
        match read_uint(s, pos) {
            Some(v) => e = Some(v),
            None => *pos = save,
        }
    }
    match c {
        'I' => Desc::I(w.unwrap_or(12), d),
        'F' => Desc::F(w.unwrap_or(15), d.unwrap_or(7)),
        'E' if es => Desc::ES(w.unwrap_or(15), d.unwrap_or(7), e),
        'E' => Desc::E(w.unwrap_or(15), d.unwrap_or(7), e),
        'D' => Desc::D(w.unwrap_or(25), d.unwrap_or(16)),
        'G' => Desc::G(w.unwrap_or(15), d.unwrap_or(7), e),
        'A' => Desc::A(w),
        'L' => Desc::L(w.unwrap_or(2)),
        other => panic!("unsupported FORMAT descriptor {other}"),
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

struct Out {
    records: Vec<String>,
    line: Vec<char>,
    col: usize,
    scale: i32,
    plus: bool,
}

impl Out {
    fn put(&mut self, text: &str) {
        for ch in text.chars() {
            if self.col < self.line.len() {
                self.line[self.col] = ch;
            } else {
                while self.line.len() < self.col {
                    self.line.push(' ');
                }
                self.line.push(ch);
            }
            self.col += 1;
        }
    }
    fn newline(&mut self) {
        self.records.push(self.line.iter().collect());
        self.line.clear();
        self.col = 0;
    }
}

enum Flow {
    Continue,
    /// No more items; stop at this data descriptor.
    Done,
}

/// Format the items; returns the records.
pub fn write_fmt(fmt: &str, vals: &[FVal]) -> Vec<String> {
    let items = parse(fmt);
    // Expand COMPLEX items into two reals.
    let mut flat = Vec::with_capacity(vals.len());
    for v in vals {
        match v {
            FVal::C(c) => {
                flat.push(FVal::R(c.re));
                flat.push(FVal::R(c.im));
            }
            other => flat.push(other.clone()),
        }
    }
    let mut out = Out { records: Vec::new(), line: Vec::new(), col: 0, scale: 0, plus: false };
    let mut next = 0usize;
    // Reversion point: the last top-level group (with its repeat), else the whole format.
    let revert_at = items.iter().rposition(|it| matches!(it, Item::Group(_, _))).unwrap_or(0);
    let mut first = true;
    loop {
        let start = if first { 0 } else { revert_at };
        let consumed_before = next;
        let flow = run_items(&items[start..], &flat, &mut next, &mut out, true);
        first = false;
        match flow {
            Flow::Done => break,
            Flow::Continue => {
                if next >= flat.len() {
                    break;
                }
                if next == consumed_before {
                    // Format with no data descriptors: avoid an infinite loop.
                    break;
                }
                out.newline();
            }
        }
    }
    out.newline();
    out.records
}

/// Format into a single string (records joined by '\n'), as an internal
/// WRITE into a CHARACTER variable of unlimited length would give.
pub fn write_line(fmt: &str, vals: &[FVal]) -> String {
    write_fmt(fmt, vals).join("\n")
}

fn run_items(items: &[Item], vals: &[FVal], next: &mut usize, out: &mut Out, top: bool) -> Flow {
    let _ = top;
    for item in items {
        match item {
            Item::Data(desc) => {
                if *next >= vals.len() {
                    return Flow::Done;
                }
                let v = &vals[*next];
                *next += 1;
                let text = edit(desc, v, out.scale, out.plus);
                out.put(&text);
            }
            Item::Lit(s) => out.put(s),
            Item::X(n) => out.col += n,
            Item::T(n) => out.col = n.saturating_sub(1),
            Item::TL(n) => out.col = out.col.saturating_sub(*n),
            Item::TR(n) => out.col += n,
            Item::Slash => out.newline(),
            Item::Colon => {
                if *next >= vals.len() {
                    return Flow::Done;
                }
            }
            Item::P(k) => out.scale = *k,
            Item::SignPlus(p) => out.plus = *p,
            Item::Group(n, inner) => {
                for _ in 0..*n {
                    if let Flow::Done = run_items(inner, vals, next, out, false) {
                        return Flow::Done;
                    }
                }
            }
            Item::Rep(n, desc) => {
                for _ in 0..*n {
                    if *next >= vals.len() {
                        return Flow::Done;
                    }
                    let v = &vals[*next];
                    *next += 1;
                    let text = edit(desc, v, out.scale, out.plus);
                    out.put(&text);
                }
            }
        }
    }
    Flow::Continue
}

fn stars(w: usize) -> String {
    "*".repeat(w)
}

fn rjust(s: &str, w: usize) -> String {
    if s.len() > w {
        stars(w)
    } else {
        format!("{:>w$}", s, w = w)
    }
}

fn as_f64(v: &FVal) -> f64 {
    match v {
        FVal::R(x) => *x as f64,
        FVal::D(x) => *x,
        FVal::I(i) => *i as f64,
        _ => 0.0,
    }
}

fn is_single(v: &FVal) -> bool {
    matches!(v, FVal::R(_))
}

fn edit(desc: &Desc, v: &FVal, scale: i32, plus: bool) -> String {
    match desc {
        Desc::I(w, m) => {
            let n = match v {
                FVal::I(i) => *i as i64,
                FVal::R(x) => *x as i64,
                FVal::D(x) => *x as i64,
                _ => 0,
            };
            let mut digits = n.unsigned_abs().to_string();
            if let Some(m) = m {
                while digits.len() < *m {
                    digits.insert(0, '0');
                }
                if *m == 0 && n == 0 {
                    digits.clear();
                }
            }
            let s = if n < 0 {
                format!("-{digits}")
            } else if plus {
                format!("+{digits}")
            } else {
                digits
            };
            rjust(&s, *w)
        }
        Desc::A(w) => {
            let s = match v {
                FVal::S(s) => s.clone(),
                other => format!("{other:?}"),
            };
            match w {
                None => s,
                Some(w) => {
                    let n = s.chars().count();
                    if n >= *w {
                        s.chars().take(*w).collect()
                    } else {
                        format!("{}{}", " ".repeat(w - n), s)
                    }
                }
            }
        }
        Desc::L(w) => {
            let b = matches!(v, FVal::L(true));
            rjust(if b { "T" } else { "F" }, *w)
        }
        Desc::F(w, d) => fmt_f(as_f64(v), *w, *d, scale, plus),
        Desc::E(w, d, e) => fmt_e(as_f64(v), *w, *d, *e, scale, plus, 'E', is_single(v)),
        Desc::ES(w, d, e) => fmt_e(as_f64(v), *w, *d, *e, 1, plus, 'E', is_single(v)),
        Desc::D(w, d) => fmt_e(as_f64(v), *w, *d, None, scale, plus, 'D', is_single(v)),
        Desc::G(w, d, e) => fmt_g(as_f64(v), *w, *d, *e, scale, plus, is_single(v)),
    }
}

/// Fw.d (with kP scaling).
pub fn fmt_f(x: f64, w: usize, d: usize, scale: i32, plus: bool) -> String {
    if !x.is_finite() {
        return fmt_nonfinite(x, w);
    }
    let y = x * 10f64.powi(scale);
    let mut body = format!("{:.*}", d, y.abs());
    let negative = y.is_sign_negative() && body.chars().any(|c| c.is_ascii_digit() && c != '0');
    // gfortran drops the leading zero before the point only when it would not fit.
    let sign_len = if negative || plus { 1 } else { 0 };
    if body.starts_with("0.") && body.len() + sign_len > w {
        body.remove(0);
    }
    if d == 0 {
        body.push('.');
    }
    let s = if negative {
        format!("-{body}")
    } else if plus {
        format!("+{body}")
    } else {
        body
    };
    rjust(&s, w)
}

fn fmt_nonfinite(x: f64, w: usize) -> String {
    let s = if x.is_nan() {
        "NaN".to_string()
    } else if x > 0.0 {
        if w >= 8 { "Infinity".to_string() } else { "Inf".to_string() }
    } else if w >= 9 {
        "-Infinity".to_string()
    } else {
        "-Inf".to_string()
    };
    rjust(&s, w)
}

/// Decimal digits of |x| rounded to `n` significant digits: (digits, exponent)
/// such that |x| = 0.d1d2...dn × 10^exponent.
fn sig_digits(x: f64, n: usize, single: bool) -> (Vec<u8>, i32) {
    if x == 0.0 {
        return (vec![0; n.max(1)], 0);
    }
    // Rust's `{:e}` rounds the exact binary value correctly, like glibc printf.
    let s = if single {
        format!("{:.*e}", n.saturating_sub(1), (x.abs() as f32) as f64)
    } else {
        format!("{:.*e}", n.saturating_sub(1), x.abs())
    };
    let (mant, exp) = s.split_once('e').unwrap();
    let digits: Vec<u8> = mant.bytes().filter(|b| b.is_ascii_digit()).map(|b| b - b'0').collect();
    let e: i32 = exp.parse().unwrap();
    (digits, e + 1)
}

/// Ew.d[Ee] with kP scaling, as gfortran writes it.
#[allow(clippy::too_many_arguments)]
pub fn fmt_e(x: f64, w: usize, d: usize, e: Option<usize>, scale: i32, plus: bool, letter: char, single: bool) -> String {
    if !x.is_finite() {
        return fmt_nonfinite(x, w);
    }
    let k = scale;
    // Significant digits written: d+k if k>0, else d+k (digits after point is d-|k| zeros...).
    let nsig = if k > 0 { d as i32 + 1 } else { d as i32 + k };
    let nsig = nsig.max(1) as usize;
    let (digits, exp10) = sig_digits(x, nsig, single);
    let is_zero = x == 0.0;
    let expo = if is_zero { 0 } else { exp10 - k };
    let mut body = String::new();
    if k > 0 {
        let kk = k as usize;
        for i in 0..kk {
            body.push((b'0' + digits.get(i).copied().unwrap_or(0)) as char);
        }
        body.push('.');
        for i in kk..nsig {
            body.push((b'0' + digits.get(i).copied().unwrap_or(0)) as char);
        }
    } else {
        body.push_str("0.");
        for _ in 0..(-k) {
            body.push('0');
        }
        for i in 0..nsig {
            body.push((b'0' + digits.get(i).copied().unwrap_or(0)) as char);
        }
    }
    let ae = expo.unsigned_abs();
    let esign = if expo < 0 { '-' } else { '+' };
    let exp_str = match e {
        Some(ew) => {
            let digits = format!("{:0width$}", ae, width = ew);
            if digits.len() > ew {
                return stars(w);
            }
            format!("{letter}{esign}{digits}")
        }
        None => {
            if ae <= 99 {
                format!("{letter}{esign}{:02}", ae)
            } else if ae <= 999 {
                format!("{esign}{:03}", ae)
            } else {
                return stars(w);
            }
        }
    };
    let negative = x.is_sign_negative() && !is_zero;
    let sign = if negative {
        "-"
    } else if plus {
        "+"
    } else {
        ""
    };
    let mut s = format!("{sign}{body}{exp_str}");
    if s.len() > w && k <= 0 && body.starts_with("0.") {
        // Drop the optional leading zero.
        s = format!("{sign}{}{exp_str}", &body[1..]);
    }
    rjust(&s, w)
}

/// Gw.d: F editing for 0.1 <= |x| < 10**d (with 4 trailing blanks), else E.
#[allow(clippy::too_many_arguments)]
pub fn fmt_g(x: f64, w: usize, d: usize, e: Option<usize>, scale: i32, plus: bool, single: bool) -> String {
    if !x.is_finite() {
        return fmt_nonfinite(x, w);
    }
    let ax = x.abs();
    if ax == 0.0 {
        let n = e.map(|v| v + 2).unwrap_or(4);
        let f = fmt_f(0.0, w - n, d.saturating_sub(1), 0, plus);
        return format!("{f}{}", " ".repeat(n));
    }
    // libgfortran compares against 10**k * (1 - 0.5 * 10**-d) evaluated in the
    // item's own precision, so e.g. 99.95 (REAL) with d=3 edits as "100.".
    let exp10 = match g_exponent(ax, d, single) {
        Some(k) => k,
        None => return fmt_e(x, w, d, e, scale, plus, 'E', single),
    };
    {
        let n = e.map(|v| v + 2).unwrap_or(4);
        let decimals = (d as i32 - exp10).max(0) as usize;
        let f = fmt_f(x, w.saturating_sub(n), decimals, 0, plus);
        format!("{f}{}", " ".repeat(n))
    }
}

/// The k of Fortran's G rule (10**(k-1) <= m < 10**k after rounding), or
/// None when E editing applies.
fn g_exponent(m: f64, d: usize, single: bool) -> Option<i32> {
    if single {
        let m = m as f32;
        let r = 0.5f32;
        let exp_d = 10f32.powi(d as i32);
        let rexp_d = 1.0 / exp_d;
        if m < 0.1 - 0.1 * r * rexp_d || m >= exp_d - r {
            return None;
        }
        for k in 0..=d as i32 {
            let t = 10f32.powi(k) * (1.0 - r * rexp_d);
            if m < t {
                return Some(k);
            }
        }
        None
    } else {
        let r = 0.5f64;
        let exp_d = 10f64.powi(d as i32);
        let rexp_d = 1.0 / exp_d;
        if m < 0.1 - 0.1 * r * rexp_d || m >= exp_d - r {
            return None;
        }
        for k in 0..=d as i32 {
            let t = 10f64.powi(k) * (1.0 - r * rexp_d);
            if m < t {
                return Some(k);
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/// Destination kinds for formatted READ.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RKind {
    I,
    R,
    D,
    L,
    /// CHARACTER of the given length.
    S(usize),
    C,
}

/// A cursor over input records for READ statements.
pub struct Reader<'a> {
    pub records: &'a [String],
    pub rec: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReadErr {
    End,
    Bad(String),
}

/// Formatted READ of `kinds.len()` items starting at record `*rec`.
/// Advances `*rec` past the records consumed.
pub fn read_fmt(fmt: &str, records: &[String], rec: &mut usize, kinds: &[RKind]) -> Result<Vec<FVal>, ReadErr> {
    let fmt_trim = fmt.trim();
    if fmt_trim == "*" || fmt_trim.is_empty() {
        return read_list(records, rec, kinds);
    }
    let items = parse(fmt);
    let mut flat_kinds = Vec::new();
    for k in kinds {
        if *k == RKind::C {
            flat_kinds.push(RKind::R);
            flat_kinds.push(RKind::R);
        } else {
            flat_kinds.push(*k);
        }
    }
    if *rec >= records.len() {
        return Err(ReadErr::End);
    }
    let mut st = InState { line: records[*rec].chars().collect(), col: 0, scale: 0 };
    let mut out = Vec::new();
    let revert_at = items.iter().rposition(|it| matches!(it, Item::Group(_, _))).unwrap_or(0);
    let mut first = true;
    loop {
        let start = if first { 0 } else { revert_at };
        first = false;
        let before = out.len();
        let done = read_items(&items[start..], &flat_kinds, &mut out, &mut st, records, rec)?;
        if done || out.len() >= flat_kinds.len() {
            break;
        }
        if out.len() == before {
            break;
        }
        // Reversion starts a new record.
        *rec += 1;
        if *rec >= records.len() {
            return Err(ReadErr::End);
        }
        st.line = records[*rec].chars().collect();
        st.col = 0;
    }
    *rec += 1;
    // Recombine complex pairs.
    let mut vals = Vec::with_capacity(kinds.len());
    let mut it = out.into_iter();
    for k in kinds {
        if *k == RKind::C {
            let re = match it.next() {
                Some(FVal::R(x)) => x,
                _ => 0.0,
            };
            let im = match it.next() {
                Some(FVal::R(x)) => x,
                _ => 0.0,
            };
            vals.push(FVal::C(C32::new(re, im)));
        } else if let Some(v) = it.next() {
            vals.push(v);
        }
    }
    Ok(vals)
}

struct InState {
    line: Vec<char>,
    col: usize,
    scale: i32,
}

fn take_field(st: &mut InState, w: usize) -> String {
    let mut s = String::new();
    for i in 0..w {
        let c = st.line.get(st.col + i).copied().unwrap_or(' ');
        s.push(c);
    }
    st.col += w;
    s
}

fn read_items(items: &[Item], kinds: &[RKind], out: &mut Vec<FVal>, st: &mut InState, records: &[String], rec: &mut usize) -> Result<bool, ReadErr> {
    for item in items {
        match item {
            Item::Data(desc) => {
                if out.len() >= kinds.len() {
                    return Ok(true);
                }
                let kind = kinds[out.len()];
                let v = read_one(desc, kind, st)?;
                out.push(v);
            }
            Item::Lit(s) => st.col += s.chars().count(),
            Item::X(n) | Item::TR(n) => st.col += n,
            Item::T(n) => st.col = n.saturating_sub(1),
            Item::TL(n) => st.col = st.col.saturating_sub(*n),
            Item::Slash => {
                *rec += 1;
                if *rec >= records.len() {
                    return Err(ReadErr::End);
                }
                st.line = records[*rec].chars().collect();
                st.col = 0;
            }
            Item::Colon => {
                if out.len() >= kinds.len() {
                    return Ok(true);
                }
            }
            Item::P(k) => st.scale = *k,
            Item::SignPlus(_) => {}
            Item::Group(n, inner) => {
                for _ in 0..*n {
                    if read_items(inner, kinds, out, st, records, rec)? {
                        return Ok(true);
                    }
                }
            }
            Item::Rep(n, desc) => {
                for _ in 0..*n {
                    if out.len() >= kinds.len() {
                        return Ok(true);
                    }
                    let kind = kinds[out.len()];
                    let v = read_one(desc, kind, st)?;
                    out.push(v);
                }
            }
        }
    }
    Ok(false)
}

fn read_one(desc: &Desc, kind: RKind, st: &mut InState) -> Result<FVal, ReadErr> {
    match desc {
        Desc::A(w) => {
            let len = match kind {
                RKind::S(n) => n,
                _ => 1,
            };
            let w = w.unwrap_or(len);
            let field = take_field(st, w);
            // Aw with w > len keeps the rightmost len characters.
            let chars: Vec<char> = field.chars().collect();
            let s: String = if w > len { chars[w - len..].iter().collect() } else { field };
            Ok(FVal::S(s))
        }
        Desc::I(w, _) => {
            let f = take_field(st, *w);
            let t: String = f.chars().filter(|c| *c != ' ').collect();
            let n = if t.is_empty() { 0 } else { t.parse::<i32>().map_err(|_| ReadErr::Bad(f.clone()))? };
            Ok(convert_num(n as f64, kind))
        }
        Desc::L(w) => {
            let f = take_field(st, *w);
            let t = f.trim().trim_start_matches('.').to_ascii_uppercase();
            Ok(FVal::L(t.starts_with('T')))
        }
        Desc::F(w, d) | Desc::E(w, d, _) | Desc::ES(w, d, _) | Desc::D(w, d) | Desc::G(w, d, _) => {
            let f = take_field(st, *w);
            if kind == RKind::R || kind == RKind::C {
                // gfortran rounds the decimal text straight to single precision.
                if let Some(x) = parse_real_field_f32(&f, *d, st.scale) {
                    return Ok(FVal::R(x));
                }
            }
            let x = parse_real_field(&f, *d, st.scale).map_err(|_| ReadErr::Bad(f.clone()))?;
            Ok(convert_num(x, kind))
        }
    }
}

fn convert_num(x: f64, kind: RKind) -> FVal {
    match kind {
        RKind::I => FVal::I(x as i32),
        RKind::D => FVal::D(x),
        RKind::L => FVal::L(x != 0.0),
        RKind::S(_) => FVal::S(x.to_string()),
        _ => FVal::R(x as f32),
    }
}

/// Parse a real input field (blanks ignored; implied decimal point from d).
pub fn parse_real_field(f: &str, d: usize, scale: i32) -> Result<f64, ()> {
    let t: String = f.chars().filter(|c| *c != ' ').collect();
    if t.is_empty() {
        return Ok(0.0);
    }
    let t = t.replace(['D', 'd', 'Q', 'q'], "E");
    let has_point = t.contains('.');
    let has_exp = t.contains(['E', 'e']) || t[1..].contains(['+', '-']);
    // Forms such as 1.5-03 (exponent without letter).
    let mut norm = t.clone();
    if !t.contains(['E', 'e']) {
        if let Some(p) = t[1..].find(['+', '-']) {
            norm = format!("{}E{}", &t[..p + 1], &t[p + 1..]);
        }
    }
    let mut x: f64 = norm.parse::<f64>().or_else(|_| fast_float_fallback(&norm)).map_err(|_| ())?;
    if !has_point {
        x /= 10f64.powi(d as i32);
    }
    if !has_exp && scale != 0 {
        x /= 10f64.powi(scale);
    }
    Ok(x)
}

/// A REAL field parsed directly to f32 when it has an explicit decimal point
/// and needs no scaling (the usual case); None otherwise.
fn parse_real_field_f32(f: &str, _d: usize, scale: i32) -> Option<f32> {
    let t: String = f.chars().filter(|c| *c != ' ').collect();
    if t.is_empty() || !t.contains('.') {
        return None;
    }
    let t = t.replace(['D', 'd', 'Q', 'q'], "E");
    let has_letter = t.contains(['E', 'e']);
    let has_exp = has_letter || t[1..].contains(['+', '-']);
    if scale != 0 && !has_exp {
        return None;
    }
    let norm = if has_letter {
        t
    } else if let Some(p) = t[1..].find(['+', '-']) {
        format!("{}E{}", &t[..p + 1], &t[p + 1..])
    } else {
        t
    };
    norm.parse::<f32>().ok()
}

fn fast_float_fallback(s: &str) -> Result<f64, ()> {
    // Accept a trailing exponent letter without digits, e.g. "1.0E".
    let t = s.trim_end_matches(['E', 'e']);
    t.parse::<f64>().map_err(|_| ())
}

/// List-directed READ (`READ (u, *)`): values separated by blanks, commas or
/// newlines; `r*v` repeats; quoted or bare strings; `/` ends the read.
pub fn read_list(records: &[String], rec: &mut usize, kinds: &[RKind]) -> Result<Vec<FVal>, ReadErr> {
    let mut out = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut ended = false;
    while out.len() < kinds.len() {
        if pending.is_empty() {
            if ended {
                break;
            }
            if *rec >= records.len() {
                return Err(ReadErr::End);
            }
            let (toks, slash) = tokenize_list(&records[*rec]);
            *rec += 1;
            ended = slash;
            pending = toks;
            pending.reverse();
            continue;
        }
        let tok = pending.pop().unwrap();
        let (count, value) = match tok.split_once('*') {
            Some((r, v)) if !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()) => (r.parse::<usize>().unwrap(), v.to_string()),
            _ => (1, tok),
        };
        for _ in 0..count {
            if out.len() >= kinds.len() {
                break;
            }
            let kind = kinds[out.len()];
            out.push(list_value(&value, kind)?);
        }
    }
    Ok(out)
}

fn tokenize_list(line: &str) -> (Vec<String>, bool) {
    let mut toks = Vec::new();
    let mut cur = String::new();
    let mut chars = line.chars().peekable();
    let mut slash = false;
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                let q = c;
                let mut s = String::new();
                while let Some(d) = chars.next() {
                    if d == q {
                        if chars.peek() == Some(&q) {
                            s.push(q);
                            chars.next();
                            continue;
                        }
                        break;
                    }
                    s.push(d);
                }
                cur.push('\u{1}');
                cur.push_str(&s);
            }
            ' ' | '\t' | ',' => {
                if !cur.is_empty() {
                    toks.push(std::mem::take(&mut cur));
                }
            }
            '/' => {
                slash = true;
                break;
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        toks.push(cur);
    }
    (toks, slash)
}

fn list_value(tok: &str, kind: RKind) -> Result<FVal, ReadErr> {
    let s = tok.trim_start_matches('\u{1}');
    match kind {
        RKind::S(_) => Ok(FVal::S(s.to_string())),
        RKind::L => {
            let t = s.trim_start_matches('.').to_ascii_uppercase();
            Ok(FVal::L(t.starts_with('T')))
        }
        RKind::I => s.parse::<i32>().map(FVal::I).map_err(|_| ReadErr::Bad(s.to_string())),
        _ => {
            let x = parse_real_field(s, 0, 0).map_err(|_| ReadErr::Bad(s.to_string()))?;
            Ok(convert_num(x, kind))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(fmt: &str, v: Vec<FVal>) -> String {
        write_line(fmt, &v)
    }

    #[test]
    fn integer_and_alpha() {
        assert_eq!(w("(3i5)", fv![1, -20, 300]), "    1  -20  300");
        assert_eq!(w("(1X, A, I3)", fv!["NAA", 7]), " NAA  7");
        assert_eq!(w("(i2)", fv![123]), "**");
        assert_eq!(w("(A6)", fv!["Cr"]), "    Cr");
    }

    #[test]
    fn real_editing_matches_gfortran() {
        assert_eq!(w("(f6.3)", fv![0.0839f32]), " 0.084");
        assert_eq!(w("(f5.3)", fv![0.0839f32]), "0.084");
        assert_eq!(w("(f4.3)", fv![0.0839f32]), ".084");
        assert_eq!(w("(f6.3)", fv![-0.0839f32]), "-0.084");
        assert_eq!(w("(1PE9.2)", fv![1.2e-6f32]), " 1.20E-06");
        assert_eq!(w("(E12.4)", fv![1234.5f64]), "  0.1234E+04");
        assert_eq!(w("(1p5e16.6)", fv![1.0f64]), "    1.000000E+00");
        assert_eq!(w("(1pe13.5)", fv![0.0f64]), "  0.00000E+00");
        assert_eq!(w("(E10.3)", fv![1.0e-120f64]), " 0.100-119");
        assert_eq!(w("(2E15.6)", fv![1.376081e-3f32, -3.44626e-5f32]), "   0.137608E-02  -0.344626E-04");
    }

    #[test]
    fn g_editing() {
        assert_eq!(w("(G12.4)", fv![1.5f32]), "   1.500    ");
        assert_eq!(w("(G12.4)", fv![1.5e6f32]), "  0.1500E+07");
    }

    #[test]
    fn groups_literals_and_reversion() {
        assert_eq!(write_fmt("('ch#', 2x, 'x' / (i3, 1p2e10.2))", &fv![1, 1.0f32, 2.0f32, 2, 3.0f32, 4.0f32]), vec!["ch#  x", "  1  1.00E+00  2.00E+00", "  2  3.00E+00  4.00E+00"]);
        // Output stops at the first data descriptor once the list is exhausted.
        assert_eq!(write_fmt("(' a =', i3, ' b =', i3)", &fv![5]), vec![" a =  5 b ="]);
        assert_eq!(write_fmt("(//1X, A)", &fv!["x"]), vec!["", "", " x"]);
        assert_eq!(write_fmt("(1X, 2I3)", &fv![1, 2, 3]), vec!["   1  2", "   3"]);
        assert_eq!(write_fmt("(1X, A15, 2X, A6, I3, 36(2H**))", &fv!["t", "SUB", 4]), vec![format!("{:>16}  {:>6}  4{}", "t", "SUB", "**".repeat(36))]);
    }

    #[test]
    fn formatted_and_list_directed_reads() {
        let recs = vec!["   1.376081E-03  -3.446260E-05".to_string(), "   1.749344E-03   8.183555E-04".to_string()];
        let mut rec = 0;
        let v = read_fmt("(2E15.6)", &recs, &mut rec, &[RKind::C, RKind::C]).unwrap();
        assert_eq!(rec, 2);
        match (&v[0], &v[1]) {
            (FVal::C(a), FVal::C(b)) => {
                assert_eq!(a.re, 1.376081e-3);
                assert_eq!(b.im, 8.183555e-4);
            }
            _ => panic!(),
        }
        let recs = vec!["1 2.5, 'abc' 3*7".to_string()];
        let mut rec = 0;
        let v = read_list(&recs, &mut rec, &[RKind::I, RKind::R, RKind::S(3), RKind::I, RKind::I, RKind::I]).unwrap();
        assert!(matches!(v[5], FVal::I(7)));
    }
}

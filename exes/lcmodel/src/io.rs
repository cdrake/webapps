//! Fortran I/O units over an in-memory file system, plus NAMELIST input.
//!
//! LCModel reads its control file on standard input and its data, water and
//! basis files by name, and writes .TABLE/.COORD/.PRINT/.CSV files by name.
//! Here every file lives in `Units::files` (inputs) and `Units::outputs`
//! (outputs), so the same code runs natively (the binary loads and saves the
//! files) and in WebAssembly (the browser passes and receives strings).

use crate::format::{self, FVal, RKind, ReadErr};
use crate::fortran::{FArr1, FArr2, FStr, C32};
use std::collections::{BTreeMap, HashMap};

pub const STDOUT: i32 = 6;

#[derive(Default, Debug)]
struct Unit {
    name: String,
    records: Vec<String>,
    pos: usize,
    writable: bool,
}

#[derive(Default, Debug)]
pub struct Units {
    /// Input files by name.
    pub files: HashMap<String, Vec<u8>>,
    /// Closed output files by name (and open ones on `finish`).
    pub outputs: BTreeMap<String, String>,
    /// Everything written to `*` / unit 6.
    pub stdout: String,
    /// Standard input records (the control file).
    pub stdin: Vec<String>,
    units: HashMap<i32, Unit>,
}

fn split_records(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut recs: Vec<String> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect();
    if recs.last().map(|l| l.is_empty()).unwrap_or(false) {
        recs.pop();
    }
    recs
}

impl Units {
    pub fn new() -> Self {
        Self::default()
    }

    /// Provide the control file as standard input.
    pub fn set_stdin(&mut self, text: &str) {
        self.stdin = split_records(text.as_bytes());
        self.units.insert(5, Unit { name: "stdin".into(), records: self.stdin.clone(), pos: 0, writable: false });
    }

    pub fn add_file(&mut self, name: &str, bytes: Vec<u8>) {
        self.files.insert(name.to_string(), bytes);
    }

    /// OPEN (unit, FILE=name, STATUS='OLD'): false when the file is missing
    /// (the Fortran `ERR=` branch).
    pub fn open_old(&mut self, unit: i32, name: &str) -> bool {
        let key = name.trim();
        match self.files.get(key) {
            Some(bytes) => {
                let records = split_records(bytes);
                self.units.insert(unit, Unit { name: key.to_string(), records, pos: 0, writable: false });
                true
            }
            None => false,
        }
    }

    /// OPEN for output (STATUS='UNKNOWN'/'NEW'/'REPLACE').
    pub fn open_new(&mut self, unit: i32, name: &str) -> bool {
        let key = name.trim().to_string();
        self.units.insert(unit, Unit { name: key, records: Vec::new(), pos: 0, writable: true });
        true
    }

    /// OPEN (unit, STATUS='SCRATCH').
    pub fn open_scratch(&mut self, unit: i32) {
        self.units.insert(unit, Unit { name: String::new(), records: Vec::new(), pos: 0, writable: true });
    }

    pub fn is_open(&self, unit: i32) -> bool {
        self.units.contains_key(&unit)
    }

    /// CLOSE: output units are saved to `outputs` under their file name.
    pub fn close(&mut self, unit: i32) {
        if let Some(u) = self.units.remove(&unit) {
            if u.writable && !u.name.is_empty() {
                let mut text = u.records.join("\n");
                if !u.records.is_empty() {
                    text.push('\n');
                }
                self.outputs.insert(u.name, text);
            }
        }
    }

    /// Close every open output unit.
    pub fn finish(&mut self) {
        let open: Vec<i32> = self.units.iter().filter(|(_, u)| u.writable).map(|(k, _)| *k).collect();
        for k in open {
            self.close(k);
        }
    }

    pub fn rewind(&mut self, unit: i32) {
        if let Some(u) = self.units.get_mut(&unit) {
            u.pos = 0;
        }
    }

    pub fn backspace(&mut self, unit: i32) {
        if let Some(u) = self.units.get_mut(&unit) {
            u.pos = u.pos.saturating_sub(1);
        }
    }

    /// Formatted WRITE (unit, fmt) list. Unit 6 (or `*`) goes to `stdout`.
    pub fn write(&mut self, unit: i32, fmt: &str, vals: &[FVal]) {
        let recs = format::write_fmt(fmt, vals);
        self.write_records(unit, recs);
    }

    pub fn write_records(&mut self, unit: i32, recs: Vec<String>) {
        if unit == STDOUT || unit < 0 {
            for r in recs {
                self.stdout.push_str(&r);
                self.stdout.push('\n');
            }
            return;
        }
        let u = self.units.entry(unit).or_insert_with(|| Unit { name: format!("fort.{unit}"), writable: true, ..Default::default() });
        // Sequential output truncates anything after the current position.
        u.records.truncate(u.pos);
        for r in recs {
            u.records.push(r);
        }
        u.pos = u.records.len();
    }

    /// Formatted READ (unit, fmt) of the given kinds.
    pub fn read(&mut self, unit: i32, fmt: &str, kinds: &[RKind]) -> Result<Vec<FVal>, ReadErr> {
        let u = self.units.get_mut(&unit).ok_or(ReadErr::End)?;
        let mut pos = u.pos;
        let r = format::read_fmt(fmt, &u.records, &mut pos, kinds);
        u.pos = pos;
        r
    }

    /// READ (unit, '(A)') line.
    pub fn read_line(&mut self, unit: i32) -> Result<String, ReadErr> {
        let u = self.units.get_mut(&unit).ok_or(ReadErr::End)?;
        if u.pos >= u.records.len() {
            return Err(ReadErr::End);
        }
        let l = u.records[u.pos].clone();
        u.pos += 1;
        Ok(l)
    }

    /// READ (unit, NML=group). Skips records until one containing `$group` or
    /// `&group`, then parses assignments until `$END`, `&END` or `/`.
    pub fn read_nml(&mut self, unit: i32, group: &str) -> Result<Namelist, ReadErr> {
        let u = self.units.get_mut(&unit).ok_or(ReadErr::End)?;
        let g = group.to_ascii_lowercase();
        loop {
            if u.pos >= u.records.len() {
                return Err(ReadErr::End);
            }
            let line = u.records[u.pos].clone();
            let lower = line.to_ascii_lowercase();
            let found = ["$", "&"].iter().find_map(|m| {
                let pat = format!("{m}{g}");
                lower.find(&pat).filter(|&p| {
                    let after = lower[p + pat.len()..].chars().next();
                    after.map(|c| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(true)
                }).map(|p| p + pat.len())
            });
            match found {
                None => {
                    u.pos += 1;
                }
                Some(start) => {
                    let mut text = String::new();
                    text.push_str(&line[start..]);
                    let mut k = u.pos;
                    let mut body_end = None;
                    loop {
                        if let Some(e) = find_nml_end(&text) {
                            body_end = Some(e);
                            break;
                        }
                        k += 1;
                        if k >= u.records.len() {
                            break;
                        }
                        text.push('\n');
                        text.push_str(&u.records[k]);
                    }
                    u.pos = k + 1;
                    let body = match body_end {
                        Some(e) => &text[..e],
                        None => &text[..],
                    };
                    return parse_namelist(body).map_err(ReadErr::Bad);
                }
            }
        }
    }

    /// Name of the file open on `unit`.
    pub fn name(&self, unit: i32) -> Option<&str> {
        self.units.get(&unit).map(|u| u.name.as_str())
    }
}

/// Position of the namelist terminator (outside quotes), if present.
fn find_nml_end(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if c == b'\'' || c == b'"' {
            quote = Some(c);
        } else if c == b'/' {
            return Some(i);
        } else if c == b'$' || c == b'&' {
            let rest = text[i + 1..].to_ascii_lowercase();
            if rest.starts_with("end") {
                return Some(i);
            }
        } else if c == b'!' {
            // Comment to end of line.
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        i += 1;
    }
    None
}

#[derive(Clone, Debug, PartialEq)]
pub enum NmlValue {
    Num(f64),
    Str(String),
    Log(bool),
    /// An empty value between separators: leaves the element unchanged.
    Null,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NmlItem {
    pub name: String,
    pub subs: Vec<i32>,
    pub values: Vec<NmlValue>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Namelist {
    pub items: Vec<NmlItem>,
}

impl Namelist {
    /// Last assignment to a scalar `name` (case-insensitive).
    pub fn last(&self, name: &str) -> Option<&NmlItem> {
        let n = name.to_ascii_lowercase();
        self.items.iter().rev().find(|i| i.name == n)
    }
    pub fn has(&self, name: &str) -> bool {
        self.last(name).is_some()
    }
    /// Apply every assignment to `name` onto a target, in input order.
    pub fn apply<T: NmlAssign + ?Sized>(&self, name: &str, target: &mut T) -> Result<(), String> {
        let n = name.to_ascii_lowercase();
        for it in self.items.iter().filter(|i| i.name == n) {
            target.nml_assign(&it.subs, &it.values)?;
        }
        Ok(())
    }
    /// Names that `known` does not accept (gfortran rejects unknown names).
    pub fn unknown<'a>(&'a self, known: &[&str]) -> Vec<&'a str> {
        self.items.iter().filter(|i| !known.contains(&i.name.as_str())).map(|i| i.name.as_str()).collect()
    }
}

fn parse_namelist(body: &str) -> Result<Namelist, String> {
    let toks = tokenize(body)?;
    let mut items = Vec::new();
    let mut k = 0;
    while k < toks.len() {
        // Expect NAME [ (subs) ] =
        let name = match &toks[k] {
            Tok::Word(w) => w.to_ascii_lowercase(),
            Tok::Sep => {
                k += 1;
                continue;
            }
            other => return Err(format!("namelist: expected a name, found {other:?}")),
        };
        k += 1;
        let mut subs = Vec::new();
        if let Some(Tok::Subs(s)) = toks.get(k) {
            for part in s.split(',') {
                let p = part.trim();
                let v = p.split(':').next().unwrap_or("").trim();
                subs.push(v.parse::<i32>().map_err(|_| format!("namelist: bad subscript {s}"))?);
            }
            k += 1;
        }
        match toks.get(k) {
            Some(Tok::Eq) => k += 1,
            other => return Err(format!("namelist: expected = after {name}, found {other:?}")),
        }
        let mut values = Vec::new();
        let mut last_was_value = false;
        while k < toks.len() {
            // Stop at the next "NAME =" or "NAME(...) =".
            if let Tok::Word(_) = &toks[k] {
                let next = toks.get(k + 1);
                let is_name = matches!(next, Some(Tok::Eq)) || (matches!(next, Some(Tok::Subs(_))) && matches!(toks.get(k + 2), Some(Tok::Eq)));
                if is_name {
                    break;
                }
            }
            match &toks[k] {
                Tok::Sep => {
                    if !last_was_value {
                        values.push(NmlValue::Null);
                    }
                    last_was_value = false;
                }
                Tok::Str(s) => {
                    values.push(NmlValue::Str(s.clone()));
                    last_was_value = true;
                }
                Tok::Word(w) => {
                    for v in parse_value_word(w)? {
                        values.push(v);
                    }
                    last_was_value = true;
                }
                Tok::Repeat(n, inner) => {
                    let v = match inner.as_deref() {
                        None => NmlValue::Null,
                        Some(Tok::Str(s)) => NmlValue::Str(s.clone()),
                        Some(Tok::Word(w)) => parse_scalar_word(w)?,
                        Some(other) => return Err(format!("namelist: bad repeated value {other:?}")),
                    };
                    for _ in 0..*n {
                        values.push(v.clone());
                    }
                    last_was_value = true;
                }
                Tok::Eq | Tok::Subs(_) => return Err("namelist: unexpected '=' or subscript".into()),
            }
            k += 1;
        }
        // A trailing separator does not add a null value.
        while matches!(values.last(), Some(NmlValue::Null)) {
            values.pop();
        }
        items.push(NmlItem { name, subs, values });
    }
    Ok(Namelist { items })
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Word(String),
    Str(String),
    Subs(String),
    Eq,
    Sep,
    Repeat(usize, Option<Box<Tok>>),
}

fn tokenize(body: &str) -> Result<Vec<Tok>, String> {
    let c: Vec<char> = body.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '!' {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch.is_whitespace() {
            i += 1;
            continue;
        }
        if ch == ',' || ch == ';' {
            toks.push(Tok::Sep);
            i += 1;
            continue;
        }
        if ch == '=' {
            toks.push(Tok::Eq);
            i += 1;
            continue;
        }
        if ch == '(' {
            let start = i + 1;
            while i < c.len() && c[i] != ')' {
                i += 1;
            }
            toks.push(Tok::Subs(c[start..i.min(c.len())].iter().collect()));
            i += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            let (s, next) = read_quoted(&c, i);
            toks.push(Tok::Str(s));
            i = next;
            continue;
        }
        // Bare word (name, number, logical, or r*value).
        let start = i;
        while i < c.len() && !c[i].is_whitespace() && !matches!(c[i], ',' | ';' | '=' | '(' | '\'' | '"') {
            if c[i] == '*' {
                // Repeat count.
                let n: String = c[start..i].iter().collect();
                if let Ok(n) = n.parse::<usize>() {
                    i += 1;
                    let inner = if i < c.len() && (c[i] == '\'' || c[i] == '"') {
                        let (s, next) = read_quoted(&c, i);
                        i = next;
                        Some(Box::new(Tok::Str(s)))
                    } else {
                        let s2 = i;
                        while i < c.len() && !c[i].is_whitespace() && !matches!(c[i], ',' | ';' | '=') {
                            i += 1;
                        }
                        if i == s2 {
                            None
                        } else {
                            Some(Box::new(Tok::Word(c[s2..i].iter().collect())))
                        }
                    };
                    toks.push(Tok::Repeat(n, inner));
                    break;
                }
            }
            i += 1;
        }
        if i > start && !matches!(toks.last(), Some(Tok::Repeat(_, _)) if c[start..i].contains(&'*')) {
            toks.push(Tok::Word(c[start..i].iter().collect()));
        }
    }
    Ok(toks)
}

fn read_quoted(c: &[char], at: usize) -> (String, usize) {
    let q = c[at];
    let mut i = at + 1;
    let mut s = String::new();
    while i < c.len() {
        if c[i] == q {
            if i + 1 < c.len() && c[i + 1] == q {
                s.push(q);
                i += 2;
                continue;
            }
            i += 1;
            break;
        }
        // A string continued across records keeps the newline out, as
        // gfortran joins the records.
        if c[i] != '\n' {
            s.push(c[i]);
        }
        i += 1;
    }
    (s, i)
}

fn parse_value_word(w: &str) -> Result<Vec<NmlValue>, String> {
    Ok(vec![parse_scalar_word(w)?])
}

fn parse_scalar_word(w: &str) -> Result<NmlValue, String> {
    let lower = w.to_ascii_lowercase();
    let t = lower.trim_start_matches('.');
    if t.starts_with('t') && (t == "t" || t.starts_with("true")) {
        return Ok(NmlValue::Log(true));
    }
    if t.starts_with('f') && (t == "f" || t.starts_with("false")) {
        return Ok(NmlValue::Log(false));
    }
    let norm = lower.replace(['d', 'q'], "e");
    norm.parse::<f64>().map(NmlValue::Num).map_err(|_| format!("namelist: bad value {w}"))
}

/// Assignment of namelist values onto a Fortran variable.
pub trait NmlAssign {
    fn nml_assign(&mut self, subs: &[i32], vals: &[NmlValue]) -> Result<(), String>;
}

/// A scalar that can receive one namelist value.
pub trait NmlScalar {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String>;
}

impl NmlScalar for i32 {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String> {
        match v {
            NmlValue::Num(x) => {
                if x.fract() != 0.0 {
                    return Err(format!("namelist: {x} is not an integer"));
                }
                *self = *x as i32;
                Ok(())
            }
            NmlValue::Null => Ok(()),
            other => Err(format!("namelist: expected an integer, got {other:?}")),
        }
    }
}

impl NmlScalar for f32 {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String> {
        match v {
            // Round through the decimal text as gfortran does for REAL input.
            NmlValue::Num(x) => {
                *self = *x as f32;
                Ok(())
            }
            NmlValue::Null => Ok(()),
            other => Err(format!("namelist: expected a real, got {other:?}")),
        }
    }
}

impl NmlScalar for f64 {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String> {
        match v {
            NmlValue::Num(x) => {
                *self = *x;
                Ok(())
            }
            NmlValue::Null => Ok(()),
            other => Err(format!("namelist: expected a real, got {other:?}")),
        }
    }
}

impl NmlScalar for bool {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String> {
        match v {
            NmlValue::Log(b) => {
                *self = *b;
                Ok(())
            }
            NmlValue::Null => Ok(()),
            other => Err(format!("namelist: expected a logical, got {other:?}")),
        }
    }
}

impl NmlScalar for FStr {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String> {
        match v {
            NmlValue::Str(s) => {
                self.set(s);
                Ok(())
            }
            NmlValue::Null => Ok(()),
            other => Err(format!("namelist: expected a string, got {other:?}")),
        }
    }
}

impl NmlScalar for C32 {
    fn set_value(&mut self, v: &NmlValue) -> Result<(), String> {
        match v {
            NmlValue::Num(x) => {
                *self = C32::new(*x as f32, 0.0);
                Ok(())
            }
            NmlValue::Null => Ok(()),
            other => Err(format!("namelist: expected a complex, got {other:?}")),
        }
    }
}

macro_rules! scalar_assign {
    ($($t:ty),*) => {$(
        impl NmlAssign for $t {
            fn nml_assign(&mut self, subs: &[i32], vals: &[NmlValue]) -> Result<(), String> {
                if !subs.is_empty() {
                    return Err("namelist: subscript on a scalar".into());
                }
                if let Some(v) = vals.first() {
                    self.set_value(v)?;
                }
                Ok(())
            }
        }
    )*};
}
scalar_assign!(i32, f32, f64, bool, FStr, C32);

impl<T: NmlScalar> NmlAssign for FArr1<T> {
    fn nml_assign(&mut self, subs: &[i32], vals: &[NmlValue]) -> Result<(), String> {
        let start = subs.first().copied().unwrap_or(self.lb);
        for (k, v) in vals.iter().enumerate() {
            let i = start + k as i32;
            if i < self.lb || i > self.ub() {
                return Err(format!("namelist: index {i} out of bounds"));
            }
            self[i].set_value(v)?;
        }
        Ok(())
    }
}

impl<T: NmlScalar> NmlAssign for FArr2<T> {
    fn nml_assign(&mut self, subs: &[i32], vals: &[NmlValue]) -> Result<(), String> {
        let (i0, j0) = match subs {
            [] => (self.lb1, self.lb2),
            [i] => (*i, self.lb2),
            [i, j, ..] => (*i, *j),
        };
        let mut off = self.offset(i0, j0);
        for v in vals {
            if off >= self.data.len() {
                return Err("namelist: too many values".into());
            }
            self.data[off].set_value(v)?;
            off += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lcmodel_control_namelist() {
        let mut u = Units::new();
        u.set_stdin(" $LCMODL\n key=210387309\n nunfil=1024\n deltat=5e-04\n hzpppm=127.786142\n filbas='3t.basis'\n chcomb(3)='A+B', 'C+D'\n ppmmet(1,2)=2*1.5, 3.\n dows=T, doecc=.false.\n $END\n");
        let nml = u.read_nml(5, "LCMODL").unwrap();
        let mut nunfil = 0i32;
        nml.apply("nunfil", &mut nunfil).unwrap();
        assert_eq!(nunfil, 1024);
        let mut hz = 0f32;
        nml.apply("HZPPPM", &mut hz).unwrap();
        assert_eq!(hz, 127.786142);
        let mut fil = FStr::blank(10);
        nml.apply("filbas", &mut fil).unwrap();
        assert_eq!(fil.trim(), "3t.basis");
        let mut comb = crate::fortran::fstr_arr1(5, 8);
        nml.apply("chcomb", &mut comb).unwrap();
        assert_eq!(comb[4].trim(), "C+D");
        let mut ppm: FArr2<f32> = FArr2::new(4, 3);
        nml.apply("ppmmet", &mut ppm).unwrap();
        assert_eq!(ppm[(3, 2)], 3.0);
        assert_eq!(ppm[(2, 2)], 1.5);
        let mut dows = false;
        nml.apply("dows", &mut dows).unwrap();
        assert!(dows);
    }

    #[test]
    fn reads_raw_header_then_data() {
        let mut u = Units::new();
        u.add_file("d.raw", b" $NMID\n ID='x', FMTDAT='(2E15.6)'\n VOLUME=1\n TRAMP=1\n $END\n   1.000000E-03  -2.000000E-05\n   3.000000E-03   4.000000E-04\n".to_vec());
        assert!(u.open_old(1, "d.raw"));
        let nml = u.read_nml(1, "NMID").unwrap();
        assert_eq!(nml.last("fmtdat").unwrap().values[0], NmlValue::Str("(2E15.6)".into()));
        let v = u.read(1, "(2E15.6)", &[RKind::C, RKind::C]).unwrap();
        assert!(matches!(v[1], FVal::C(c) if c.re == 3.0e-3));
    }
}

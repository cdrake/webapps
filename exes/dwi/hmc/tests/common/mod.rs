//! Helpers shared by the data-gated reference tests. Each test file uses a part of them.
#![allow(dead_code)]

use flate2::read::GzDecoder;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The reference folder (`HMC_REFERENCE`) when it holds `subset`, else `None`.
///
/// Without `HMC_REFERENCE` the caller skips, unless `HMC_REQUIRE_REFERENCE` is set: then it is a
/// failure. A folder whose `HMC_REFERENCE_SUBSETS` (as `fetch_reference.py` prints it) does not
/// name `subset` is skipped: the CI job fetches only the subsets that its tests read.
pub fn reference(subset: &str) -> Option<PathBuf> {
    let Ok(root) = std::env::var("HMC_REFERENCE") else {
        if std::env::var_os("HMC_REQUIRE_REFERENCE").is_some() {
            panic!("HMC_REFERENCE is not set, but HMC_REQUIRE_REFERENCE is set");
        }
        eprintln!("HMC_REFERENCE is not set; this {subset} check does not run");
        return None;
    };
    if let Ok(list) = std::env::var("HMC_REFERENCE_SUBSETS") {
        if list != "all" && !list.split(',').any(|s| s.trim() == subset) {
            eprintln!("HMC_REFERENCE_SUBSETS does not name {subset}; this check does not run");
            return None;
        }
    }
    Some(PathBuf::from(root))
}

/// A shell command as words, with each bracket group joined into one word and its spaces
/// removed: `Rigid[ 12.0 ]` is one word, `Rigid[12.0]`.
pub fn bracket_words(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut word = String::new();
    for c in command.chars() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            _ => {}
        }
        if c.is_whitespace() {
            if depth == 0 && !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// A NIfTI-1 image: the grid, the data type code and the raw little-endian values.
pub struct Nifti {
    pub dim: Vec<usize>,
    pub datatype: i16,
    bytes: Vec<u8>,
}

pub fn read_nifti(path: &Path) -> Nifti {
    let mut raw = Vec::new();
    GzDecoder::new(std::fs::File::open(path).unwrap_or_else(|e| panic!("{path:?}: {e}")))
        .read_to_end(&mut raw)
        .unwrap();
    let i16_at = |o: usize| i16::from_le_bytes([raw[o], raw[o + 1]]);
    let f32_at = |o: usize| f32::from_le_bytes(raw[o..o + 4].try_into().unwrap());
    assert_eq!(
        i32::from_le_bytes(raw[0..4].try_into().unwrap()),
        348,
        "{path:?}: not a little-endian NIfTI-1 file"
    );
    let ndim = i16_at(40) as usize;
    let dim: Vec<usize> = (1..=ndim).map(|k| i16_at(40 + 2 * k) as usize).collect();
    let datatype = i16_at(70);
    let slope = f32_at(112);
    assert!(
        slope.is_nan() || slope == 0.0 || (slope == 1.0 && f32_at(116) == 0.0),
        "{path:?}: scaled data"
    );
    let offset = f32_at(108) as usize;
    Nifti {
        dim,
        datatype,
        bytes: raw[offset..].to_vec(),
    }
}

impl Nifti {
    pub fn len(&self) -> usize {
        self.dim.iter().product()
    }

    pub fn i16s(&self) -> Vec<i16> {
        assert_eq!(self.datatype, 4);
        self.bytes[..2 * self.len()]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    pub fn f64s(&self) -> Vec<f64> {
        let n = self.len();
        match self.datatype {
            2 => self.bytes[..n].iter().map(|&b| b as f64).collect(),
            4 => self.i16s().into_iter().map(f64::from).collect(),
            16 => self.bytes[..4 * n]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()) as f64)
                .collect(),
            64 => self.bytes[..8 * n]
                .chunks_exact(8)
                .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
                .collect(),
            t => panic!("NIfTI data type {t} is not read here"),
        }
    }
}

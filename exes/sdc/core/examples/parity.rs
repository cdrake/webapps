//! Compares each stage of the Rust port with PyHySCO's float64 checkpoints.
//!
//! Usage: parity <dir>, where <dir> holds what `validation/pyhysco_reference.py` writes: raw
//! little-endian f64 arrays and `meta.txt` (m, then the permuted voxel sizes).

use sdc_core::hysco::{self, Grid, Options};

fn load(dir: &str, name: &str) -> Vec<f64> {
    std::fs::read(format!("{dir}/{name}.f64"))
        .unwrap_or_else(|e| panic!("{name}: {e}"))
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn report(name: &str, rust: &[f64], python: &[f64]) {
    let max_abs = python.iter().fold(0.0f64, |a, v| a.max(v.abs()));
    let diff = rust
        .iter()
        .zip(python)
        .fold(0.0f64, |a, (r, p)| a.max((r - p).abs()));
    println!(
        "{name:8} max |rust - python| {diff:.3e}  (max |python| {max_abs:.3e}, relative {:.3e})",
        diff / max_abs
    );
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: parity <dir>");
    let meta: Vec<f64> = std::fs::read_to_string(format!("{dir}/meta.txt"))
        .unwrap()
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    let m = [meta[0] as usize, meta[1] as usize, meta[2] as usize];
    let g = Grid::new(m, [meta[3], meta[4], meta[5]]);
    let (i1, i2) = (load(&dir, "i1"), load(&dir, "i2"));
    let options = Options::default();
    let (cf, b0) = hysco::initialize(g, &i1, &i2);
    report("b0_cf", &cf, &load(&dir, "b0_cf"));
    report("b0_cf64", &cf, &load(&dir, "b0_cf64"));
    report("b064", &b0, &load(&dir, "b064"));
    report("b0", &b0, &load(&dir, "b0"));
    let py_b0 = load(&dir, "b0");
    let (j0, dj0) = hysco::objective(g, &i1, &i2, &py_b0, &options);
    let py_j0 = load(&dir, "j0")[0];
    println!(
        "j0       rust {j0:.12e} python {py_j0:.12e} relative {:.3e}",
        (j0 - py_j0).abs() / py_j0
    );
    report("dj0", &dj0, &load(&dir, "dj0"));
    let one = hysco::gauss_newton(
        g,
        &i1,
        &i2,
        py_b0.clone(),
        &Options {
            max_iter: 1,
            ..options
        },
    );
    report("b1", &one.b, &load(&dir, "b1"));
    let t = std::time::Instant::now();
    let full = hysco::gauss_newton(g, &i1, &i2, py_b0, &options);
    println!(
        "full run from python b0: {} iterations, {:.2} s",
        full.loss.len() - 1,
        t.elapsed().as_secs_f64()
    );
    report("b", &full.b, &load(&dir, "b"));
    report("corr1", &full.corr1, &load(&dir, "corr1"));
    let py_loss = load(&dir, "log_loss");
    println!("loss rust {:?}\nloss py   {:?}", full.loss, py_loss);
    let t = std::time::Instant::now();
    let solo = hysco::solve(g, &i1, &i2, &options);
    println!(
        "full run from rust b0: {} iterations, {:.2} s",
        solo.loss.len() - 1,
        t.elapsed().as_secs_f64()
    );
    report("b solo", &solo.b, &load(&dir, "b"));
}

//! io_writelcm (byte-identical text) and io_readlcmraw against FID-A, plus
//! io_loadspec_sdat.
#[path = "readers_common/mod.rs"]
mod common;
use common::*;
use fida::io::lcmraw::RawType;
use fida::Spectra;

/// validation/export_lcm.m's `first_fid`.
fn first_fid(mut s: Spectra) -> Spectra {
    let n = s.n();
    s.fids.truncate(n);
    s.sz = vec![n, 1];
    s.dims.coils = 0;
    s.dims.averages = 0;
    s.dims.sub_specs = 0;
    s.flags.addedrcvrs = true;
    s.flags.averaged = true;
    s
}

fn same_text(name: &str, ours: &str, dir: &std::path::PathBuf, rel: &str) {
    let Some(theirs) = input(dir, rel) else { return };
    let theirs = String::from_utf8(theirs).unwrap();
    if ours != theirs {
        let (a, b): (Vec<_>, Vec<_>) = (ours.lines().collect(), theirs.lines().collect());
        let k = a.iter().zip(b.iter()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
        panic!(
            "{name}: our LCModel text differs from FID-A's at line {}:\n ours:  {:?}\n FID-A: {:?}\n ({} vs {} lines)",
            k + 1,
            a.get(k),
            b.get(k),
            a.len(),
            b.len()
        );
    }
    eprintln!("{name}: io_writelcm text identical ({} bytes)", ours.len());
}

#[test]
fn writelcm_matches_fida() {
    let Some(dir) = data_dir("writelcm_matches_fida") else { return };
    if let Some(p) = input(&dir, "GE/sample01_press/press/P17920.7") {
        let g = fida::io::ge::load(&p, 1).unwrap();
        let raw = fida::io::lcm::lcm_text(&first_fid(g.out), 35.0).unwrap();
        same_text("ge_press.RAW", &raw, &dir, "LCModel/ge_press.RAW");
        let h2o = fida::io::lcm::lcm_text(&first_fid(g.out_w), 35.0).unwrap();
        same_text("ge_press.H2O", &h2o, &dir, "LCModel/ge_press.H2O");
    }
    if let (Some(a), Some(b)) = (
        input(&dir, "Philips/philips_spar_sdat_WS.SDAT"),
        input(&dir, "Philips/philips_spar_sdat_WS.SPAR"),
    ) {
        let mut s = fida::io::sdat::load(&a, &b, 1).unwrap();
        s.flags.averaged = true;
        let raw = fida::io::lcm::lcm_text(&s, 30.0).unwrap();
        same_text("sdat_ws.RAW", &raw, &dir, "LCModel/sdat_ws.RAW");
    }
}

fn readraw(name: &str, rel: &str) {
    let Some(dir) = data_dir(name) else { return };
    let Some(bytes) = input(&dir, rel) else { return };
    let Some(r) = reference(&dir, name) else { return };
    let s = fida::io::lcmraw::load(&bytes, RawType::Dat).expect("io_readlcmraw");
    compare(name, &s, &r, &[]);
}

#[test]
fn readlcmraw_ge_raw() {
    readraw("lcm_ge_press_RAW", "LCModel/ge_press.RAW");
}

#[test]
fn readlcmraw_ge_h2o() {
    readraw("lcm_ge_press_H2O", "LCModel/ge_press.H2O");
}

#[test]
fn readlcmraw_sdat_raw() {
    readraw("lcm_sdat_ws_RAW", "LCModel/sdat_ws.RAW");
}

fn sdat(name: &str, stem: &str) {
    let Some(dir) = data_dir(name) else { return };
    let (Some(a), Some(b)) = (input(&dir, &format!("{stem}.SDAT")), input(&dir, &format!("{stem}.SPAR"))) else {
        return;
    };
    let Some(r) = reference(&dir, name) else { return };
    let s = fida::io::sdat::load(&a, &b, 1).expect("io_loadspec_sdat");
    compare(name, &s, &r, &[]);
}

#[test]
fn sdat_ws() {
    sdat("sdat_ws", "Philips/philips_spar_sdat_WS");
}

#[test]
fn sdat_w() {
    sdat("sdat_w", "Philips/philips_spar_sdat_W");
}

//! run_megapressproc_auto against FID-A (validation/ref_mega.m) on FID-A's
//! Siemens MEGA-PRESS example.
mod common;
use common::*;
use fida::ops::pipeline::{run_megapressproc_auto, MegaOptions};

#[test]
fn siemens_mega_pipeline_matches_fida() {
    let Some(d) = data_dir("siemens_mega") else { return };
    let v = Values::load(&d.join("values.json"));
    let raw = load(&d.join("raw"));
    let raww = load(&d.join("raww"));
    let t0 = std::time::Instant::now();
    let r = run_megapressproc_auto(&raw, Some(&raww), &MegaOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    eprintln!("MEGA-PRESS pipeline: {:.2} s", t0.elapsed().as_secs_f64());
    let rep = &r.report;
    let removed = rep.rm_bad_averages.as_ref().unwrap().removed.len() * 2;
    assert_eq!(removed, v.f("rm_total") as usize, "removed transients");
    let drift = rep.drift.as_ref().unwrap();
    assert_eq!(drift.iterations, v.f("aa_iterations") as usize);
    let dfs = max_abs_diff(&drift.freq, &v.vec("fscum"));
    let dph = max_abs_diff(&drift.phase, &v.vec("phscum"));
    eprintln!("cumulative drift: max |dfs| {dfs:.2e} Hz, max |dphs| {dph:.2e} deg");
    assert!(dfs < 1e-5 && dph < 1e-4);
    eprintln!("ph0 {} vs {}; subspectrum alignment {} Hz {} deg vs {} {}", rep.ph0, v.f("ph0"), rep.isis_freq[0], rep.isis_phase[0], v.f("ss_fs"), v.f("ss_phs"));
    assert!((rep.ph0 - v.f("ph0")).abs() < 1e-4);
    assert!((rep.isis_freq[0] - v.f("ss_fs")).abs() < 1e-5);
    assert!((rep.isis_phase[0] - v.f("ss_phs")).abs() < 1e-4);
    assert!((rep.freq_shift - v.f("frqShift")).abs() < 1e-6);
    for (name, got) in [("diff", &r.diff), ("sum", &r.sum), ("sub1", &r.sub1), ("sub2", &r.sub2)] {
        compare(name, got, &load(&d.join(name)), 1e-6);
    }
    compare("outw", r.outw.as_ref().unwrap(), &load(&d.join("outw")), 1e-6);
}

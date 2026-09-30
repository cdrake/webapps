//! Siemens SPECIAL example (specialDLPFC.dat + specialDLPFC_w.dat) against
//! FID-A in Octave (validation/ref_pipelines.m, validation/specialproc_det.m).

mod common;

use common::*;
use fida::ops::pipeline::{run_specialproc_auto, SpecialOptions};
use fida::ops::*;

fn fs_ok(name: &str, got: &[f64], want: &[f64], tol_hz: f64) {
    let d = max_abs_diff(got, want);
    eprintln!("{name}: max |difference| {d:.2e}");
    assert!(d < tol_hz, "{name}: {d}");
}

#[test]
fn special_steps_match_fida() {
    let Some(d) = data_dir("special") else { return };
    let v = Values::load(&d.join("values.json"));
    let raww = load(&d.join("raww"));
    let cc = op_getcoilcombos(&op_combinesubspecs(&raww, CombineMode::Diff).unwrap(), 2, CoilMode::W).unwrap();
    fs_ok("coil phases", &cc.ph, &v.vec("cc_ph"), 1e-4);
    let sig: Vec<f64> = cc.sig.iter().map(|z| z.re).collect();
    fs_ok("coil weights", &sig, &v.vec("cc_sig"), 1e-6);
    compare("out_w_cc", &op_addrcvrs(&raww, 2, CoilMode::W, Some(&cc), false).unwrap().out, &load(&d.join("out_w_cc")), 1e-12);
    {
        let raw = load(&d.join("raw"));
        let t0 = std::time::Instant::now();
        let out_cc = op_addrcvrs(&raw, 2, CoilMode::W, Some(&cc), false).unwrap();
        eprintln!("coil combination of 32 x 160 x 4096: {:.2} s", t0.elapsed().as_secs_f64());
        compare("out_cc", &out_cc.out, &load(&d.join("out_cc")), 1e-12);
    }

    let out_cc = load(&d.join("out_cc"));
    let a1 = op_align_averages(&out_cc, Some(0.4), AlignTo::Median).unwrap();
    fs_ok("ai1 fs", &a1.fs, &v.vec("ai1_fs"), 1e-5);
    fs_ok("ai1 phs", &a1.phs, &v.vec("ai1_phs"), 1e-4);
    compare("out_ai1", &a1.out, &load(&d.join("out_ai1")), 1e-6);
    let a2 = op_align_isis(&load(&d.join("out_ai1")), 0.4, None).unwrap();
    fs_ok("ai2 fs", &a2.fs, &v.vec("ai2_fs"), 1e-5);
    fs_ok("ai2 phs", &a2.phs, &v.vec("ai2_phs"), 1e-4);
    compare("out_ai2", &a2.out, &load(&d.join("out_ai2")), 1e-6);
    let a3 = op_align_averages(&load(&d.join("out_ai2")), Some(0.4), AlignTo::Median).unwrap();
    fs_ok("ai3 fs", &a3.fs, &v.vec("ai3_fs"), 1e-5);
    fs_ok("ai3 phs", &a3.phs, &v.vec("ai3_phs"), 1e-4);
    let a4 = op_align_isis(&load(&d.join("out_ai3")), 0.4, None).unwrap();
    fs_ok("ai4 fs", &a4.fs, &v.vec("ai4_fs"), 1e-5);
    fs_ok("ai4 phs", &a4.phs, &v.vec("ai4_phs"), 1e-4);
    compare("out_ai4", &a4.out, &load(&d.join("out_ai4")), 1e-6);
    let cs = op_combinesubspecs(&load(&d.join("out_ai4")), CombineMode::Diff).unwrap();
    compare("out_cs", &cs, &load(&d.join("out_cs")), 1e-12);
    compare("out_w_cs", &op_combinesubspecs(&load(&d.join("out_w_ai")), CombineMode::Diff).unwrap(), &load(&d.join("out_w_cs")), 1e-12);

    let mut cur = load(&d.join("out_cs"));
    for k in 1..=v.f("rm_iterations") as usize {
        let r = op_rmbadaverages(&cur, 3.0, Domain::Time).unwrap();
        let m = v.vec(&format!("rm_metric_{k}"));
        let rel = max_abs_diff(&r.metric, &m) / m.iter().fold(0.0f64, |a, b| a.max(b.abs()));
        eprintln!("rmbadaverages pass {k}: metric rel. difference {rel:.2e}, removed {:?}", r.bad);
        assert!(rel < 1e-10);
        let bad: Vec<usize> = v.vec(&format!("rm_bad_{k}")).iter().map(|&b| b as usize - 1).collect();
        assert_eq!(r.bad, bad);
        cur = r.out;
    }
    compare("out_rm", &cur, &load(&d.join("out_rm")), 1e-12);

    let a = op_align_averages_fd(&load(&d.join("out_rm")), 1.8, 4.2, 0.2, AlignTo::Best).unwrap();
    fs_ok("aa_fs_1", &a.fs, &v.vec("aa_fs_1"), 1e-5);
    fs_ok("aa_phs_1", &a.phs, &v.vec("aa_phs_1"), 1e-4);
    compare("out_aa_1", &a.out, &load(&d.join("out_aa_1")), 1e-6);
    let aw = op_align_averages(&load(&d.join("out_w_cs")), Some(1.0), AlignTo::Best).unwrap();
    fs_ok("aaw_fs_1", &aw.fs, &v.vec("aaw_fs_1"), 1e-5);
    compare("out_w_aa", &aw.out, &load(&d.join("out_w_aa")), 1e-6);
}

#[test]
fn special_pipeline_matches_fida() {
    let Some(d) = data_dir("special") else { return };
    let v = Values::load(&d.join("values.json"));
    let raw = load(&d.join("raw"));
    let raww = load(&d.join("raww"));
    let t0 = std::time::Instant::now();
    let r = run_specialproc_auto(&raw, Some(&raww), &SpecialOptions::default(), &mut |_, _| {}, &|| false).unwrap();
    eprintln!("SPECIAL pipeline: {:.2} s", t0.elapsed().as_secs_f64());
    let rep = &r.report;
    let rm = rep.rm_bad_averages.as_ref().unwrap();
    let bad: Vec<usize> = v.vec("rm_all_bad").iter().map(|&b| b as usize - 1).collect();
    assert_eq!(rm.removed, bad);
    let drift = rep.drift.as_ref().unwrap();
    assert_eq!(drift.iterations, v.f("aa_iterations") as usize);
    fs_ok("cumulative frequency drift", &drift.freq, &v.vec("fscum"), 1e-5);
    fs_ok("cumulative phase drift", &drift.phase, &v.vec("phscum"), 1e-4);
    assert!((rep.ph0 - v.f("ph0")).abs() < 1e-6);
    assert!((rep.ph0_water.unwrap() - v.f("ph0w")).abs() < 1e-6);
    assert!((rep.freq_shift - v.f("frqShift")).abs() < 1e-9);
    assert!((rep.freq_shift_water.unwrap() - v.f("frqShiftw")).abs() < 1e-9);
    compare("out", &r.out, &load(&d.join("out")), 1e-6);
    compare("out_w", r.outw.as_ref().unwrap(), &load(&d.join("out_w")), 1e-6);
    compare("out_noproc", &r.out_noproc, &load(&d.join("out_noproc")), 1e-6);
    compare("out_w_noproc", r.outw_noproc.as_ref().unwrap(), &load(&d.join("out_w_noproc")), 1e-6);
    eprintln!("SNR {:?} vs {}; LW NAA {:?} vs {}; LW water {:?} vs {}", rep.snr, v.f("snr"), rep.linewidth_naa, v.f("lw_naa"), rep.linewidth_water, v.f("lw_water"));
    assert!((rep.snr.unwrap() - v.f("snr")).abs() < 1e-6 * v.f("snr"));
    assert!((rep.linewidth_naa.unwrap() - v.f("lw_naa")).abs() < 1e-6);
    assert!((rep.linewidth_water.unwrap() - v.f("lw_water")).abs() < 1e-6);
}

/// FID-A reads twix data in single precision and so runs its first
/// alignment in single precision; the reference above is computed in double.
/// This measures how far FID-A's own float32 rounding moves the result.
#[test]
fn special_single_precision_fida_is_close() {
    let Some(d) = data_dir("special") else { return };
    let Some(s) = data_dir("special_single") else { return };
    let vs = Values::load(&s.join("values.json"));
    let vd = Values::load(&d.join("values.json"));
    let dfs = max_abs_diff(&vs.vec("fscum"), &vd.vec("fscum"));
    let dph = max_abs_diff(&vs.vec("phscum"), &vd.vec("phscum"));
    let a = load(&d.join("out"));
    let b = load(&s.join("out"));
    let e = rel_err(&b.fids, &a.fids);
    eprintln!("FID-A single vs double precision: drift max |dfs| {dfs:.2e} Hz, |dphs| {dph:.2e} deg, final spectrum relative difference {e:.2e}, ph0 {} vs {}", vs.f("ph0"), vd.f("ph0"));
    assert!(dfs < 0.5 && dph < 5.0 && e < 0.05);
}

//! GE PRESS example (P17920.7, with water frames) against FID-A in Octave
//! (validation/ref_pipelines.m, validation/pressproc_det.m). Each step runs
//! on FID-A's own input to that step; then the whole pipeline runs from the
//! raw data.

mod common;

use common::*;
use fida::ops::pipeline::{run_pressproc_auto, PressOptions};
use fida::ops::*;

#[test]
fn ge_press_steps_match_fida() {
    let Some(d) = data_dir("ge_press") else { return };
    let v = Values::load(&d.join("values.json"));
    let raw = load(&d.join("raw"));
    let raww = load(&d.join("raww"));

    // Coil combination from the water reference.
    let cc = op_getcoilcombos(&raww, 1, CoilMode::W).unwrap();
    assert!(max_abs_diff(&cc.ph, &v.vec("cc_ph")) < 1e-9, "coil phases");
    let sig: Vec<f64> = cc.sig.iter().map(|z| z.re).collect();
    assert!(max_abs_diff(&sig, &v.vec("cc_sig")) < 1e-12, "coil weights");
    let outw_cc = op_addrcvrs(&raww, 1, CoilMode::W, Some(&cc), false).unwrap();
    compare("outw_cc", &outw_cc.out, &load(&d.join("outw_cc")), 1e-12);
    let out_cc = op_addrcvrs(&raw, 1, CoilMode::W, Some(&cc), false).unwrap();
    let applied: Vec<f64> = out_cc.coilcombos.sig.iter().map(|z| z.re).collect();
    assert!(max_abs_diff(&applied, &v.vec("cc_used_sig")) < 1e-12);
    compare("out_cc", &out_cc.out, &load(&d.join("out_cc")), 1e-12);

    // Removal of bad averages, iterated.
    let mut cur = load(&d.join("out_cc"));
    let passes = v.f("rm_iterations") as usize;
    for k in 1..=passes {
        let r = op_rmbadaverages(&cur, 4.0, Domain::Time).unwrap();
        let m = v.vec(&format!("rm_metric_{k}"));
        let rel = max_abs_diff(&r.metric, &m) / m.iter().fold(0.0f64, |a, b| a.max(b.abs()));
        eprintln!("rmbadaverages pass {k}: metric rel. difference {rel:.2e}, removed {:?}", r.bad);
        assert!(rel < 1e-10);
        let bad: Vec<usize> = v.vec(&format!("rm_bad_{k}")).iter().map(|&b| b as usize - 1).collect();
        assert_eq!(r.bad, bad, "bad averages, pass {k}");
        cur = r.out;
    }
    compare("out_rm", &cur, &load(&d.join("out_rm")), 1e-12);

    // Water alignment ('n', 0.2 s).
    let a = op_align_averages(&load(&d.join("outw_cc")), Some(0.2), AlignTo::Best).unwrap();
    eprintln!("outw_aa fs {:?} vs {:?}", a.fs, v.vec("aaw_fs"));
    assert!(max_abs_diff(&a.fs, &v.vec("aaw_fs")) < 1e-6);
    assert!(max_abs_diff(&a.phs, &v.vec("aaw_phs")) < 1e-5);
    compare("outw_aa", &a.out, &load(&d.join("outw_aa")), 1e-8);

    // Drift correction passes, each from FID-A's previous output.
    let iters = v.f("aa_iterations") as usize;
    let mut prev = load(&d.join("out_rm"));
    for k in 1..=iters {
        let a = op_align_averages_fd(&prev, 1.6, 4.0, 0.25, AlignTo::Median).unwrap();
        let dfs = max_abs_diff(&a.fs, &v.vec(&format!("aa_fs_{k}")));
        let dph = max_abs_diff(&a.phs, &v.vec(&format!("aa_phs_{k}")));
        eprintln!("alignAverages_fd pass {k}: max |dfs| {dfs:.2e} Hz, max |dphs| {dph:.2e} deg");
        assert!(dfs < 1e-6 && dph < 1e-5);
        let want = load(&d.join(format!("out_aa_{k}")));
        compare(&format!("out_aa_{k}"), &a.out, &want, 1e-6);
        prev = want;
    }

    let out_av = op_averaging(&prev);
    compare("out_av", &out_av, &load(&d.join("out_av")), 1e-12);
    let out_ls = op_leftshift(&out_av, out_av.points_to_leftshift as usize).unwrap();
    compare("out_ls", &out_ls, &load(&d.join("out_ls")), 1e-12);
    let zf = op_filter(&op_zeropad(&out_ls, 16.0), 5.0);
    compare("out_ls_zp_filt", &zf, &load(&d.join("out_ls_zp_filt")), 1e-12);
    let (zf_ph, ph0) = op_autophase(&zf, 2.9, 3.1, 0.0, None).unwrap();
    assert!((ph0 - v.f("ph0")).abs() < 1e-9, "ph0 {ph0} vs {}", v.f("ph0"));
    compare("out_ls_zp_filt_ph", &zf_ph, &load(&d.join("out_ls_zp_filt_ph")), 1e-12);
    let (_, frq) = op_ppmref(&zf_ph, 2.9, 3.1, 3.027, None).unwrap();
    assert!((frq - v.f("frqShift")).abs() < 1e-9);
}

#[test]
fn ge_press_pipeline_matches_fida() {
    let Some(d) = data_dir("ge_press") else { return };
    let v = Values::load(&d.join("values.json"));
    let raw = load(&d.join("raw"));
    let raww = load(&d.join("raww"));
    let t0 = std::time::Instant::now();
    let mut log = Vec::new();
    let r = run_pressproc_auto(&raw, Some(&raww), &PressOptions::default(), &mut |m, f| log.push((m.to_string(), f)), &|| false).unwrap();
    eprintln!("GE PRESS pipeline: {:.2} s, {} progress messages", t0.elapsed().as_secs_f64(), log.len());
    let rep = &r.report;
    eprintln!("{}", serde_json::to_string(&rep.to_json()).unwrap().chars().take(600).collect::<String>());
    assert_eq!(rep.rm_bad_averages.as_ref().unwrap().removed.len(), v.f("rm_total") as usize);
    let drift = rep.drift.as_ref().unwrap();
    assert_eq!(drift.iterations, v.f("aa_iterations") as usize);
    let dfs = max_abs_diff(&drift.freq, &v.vec("fscum"));
    let dph = max_abs_diff(&drift.phase, &v.vec("phscum"));
    eprintln!("cumulative drift: max |dfs| {dfs:.2e} Hz, max |dphs| {dph:.2e} deg");
    assert!(dfs < 1e-6 && dph < 1e-5);
    assert!((rep.ph0 - v.f("ph0")).abs() < 1e-6);
    assert!((rep.ph0_water.unwrap() - v.f("ph0w")).abs() < 1e-6);
    assert!((rep.freq_shift - v.f("frqShift")).abs() < 1e-9);
    assert!((rep.freq_shift_water.unwrap() - v.f("frqShiftw")).abs() < 1e-9);
    compare("out", &r.out, &load(&d.join("out")), 1e-6);
    compare("outw", r.outw.as_ref().unwrap(), &load(&d.join("outw")), 1e-6);
    compare("out_noproc", &r.out_noproc, &load(&d.join("out_noproc")), 1e-6);
    compare("outw_noproc", r.outw_noproc.as_ref().unwrap(), &load(&d.join("outw_noproc")), 1e-6);
    let snr = rep.snr.unwrap();
    eprintln!("SNR {snr} vs {}; LW NAA {:?} vs {}; LW water {:?} vs {}", v.f("snr"), rep.linewidth_naa, v.f("lw_naa"), rep.linewidth_water, v.f("lw_water"));
    assert!((snr - v.f("snr")).abs() < 1e-6 * v.f("snr"));
    assert!((rep.linewidth_naa.unwrap() - v.f("lw_naa")).abs() < 1e-6);
    assert!((rep.linewidth_water.unwrap() - v.f("lw_water")).abs() < 1e-6);
}

/// run_pressproc_GEauto's phasing (validation/ref_geauto.m): residual-water
/// phase, applied to the water reference too.
#[test]
fn ge_press_geauto_phasing_matches_fida() {
    let Some(d) = data_dir("ge_press_geauto") else { return };
    let v = Values::load(&d.join("values.json"));
    let base = data_dir("ge_press").expect("ge_press inputs");
    let raw = load(&base.join("raw"));
    let raww = load(&base.join("raww"));
    let opts = PressOptions { ge_phasing: true, ..PressOptions::default() };
    let r = run_pressproc_auto(&raw, Some(&raww), &opts, &mut |_, _| {}, &|| false).unwrap();
    let rep = &r.report;
    eprintln!("GE phasing: ph0 {} vs {}, shift {} vs {}", rep.ph0, v.f("ph0"), rep.freq_shift, v.f("frqShift"));
    assert_eq!(rep.pipeline, "run_pressproc_GEauto");
    assert!((rep.ph0 - v.f("ph0")).abs() < 1e-6);
    assert!((rep.ph0_water.unwrap() - v.f("ph0w")).abs() < 1e-6);
    assert!((rep.freq_shift - v.f("frqShift")).abs() < 1e-9);
    assert!((rep.freq_shift_water.unwrap() - v.f("frqShiftw")).abs() < 1e-9);
    compare("out", &r.out, &load(&d.join("out")), 1e-6);
    compare("outw", r.outw.as_ref().unwrap(), &load(&d.join("outw")), 1e-6);
}

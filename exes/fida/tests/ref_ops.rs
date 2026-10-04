//! Individual ops against FID-A in Octave (validation/ref_ops.m): the modes
//! and arguments the pipelines do not exercise.

mod common;

use common::*;
use fida::ops::util::spec;
use fida::ops::*;
use num_complex::Complex64 as C;

fn close(name: &str, got: &[f64], want: &[f64], tol: f64) {
    let d = max_abs_diff(got, want);
    eprintln!("{name}: max |difference| {d:.2e}");
    assert!(d < tol, "{name}: {d} >= {tol}");
}

fn rel(name: &str, got: &[C], want: &[C], tol: f64) {
    let e = rel_err(got, want);
    eprintln!("{name}: relative difference {e:.2e}");
    assert!(e < tol, "{name}: {e} >= {tol}");
}

fn re(v: &[C]) -> Vec<f64> {
    v.iter().map(|z| z.re).collect()
}

fn idx(v: &[f64]) -> Vec<usize> {
    v.iter().filter(|x| !x.is_nan()).map(|&b| b as usize - 1).collect()
}

#[test]
fn coil_combination_modes() {
    let Some(d) = data_dir("single_ops") else { return };
    let v = Values::load(&d.join("values.json"));
    let raw = load(&d.join("raw"));
    let raww = load(&d.join("raww"));

    let cch = op_getcoilcombos(&raww, 1, CoilMode::H).unwrap();
    close("h phases", &cch.ph, &v.vec("cch_ph"), 1e-9);
    close("h weights", &re(&cch.sig), &v.vec("cch_sig"), 1e-12);
    let r = op_addrcvrs(&raw, 1, CoilMode::H, Some(&cch), false).unwrap();
    close("h weights applied", &re(&r.coilcombos.sig), &v.vec("cch_used_sig"), 1e-12);
    compare("addrcvrs_h", &r.out, &load(&d.join("addrcvrs_h")), 1e-12);

    let ccg = op_getcoilcombos(&raww, 2, CoilMode::Gls).unwrap();
    rel("gls sig", &ccg.sig, &v.cvec("ccg_sig"), 1e-13);
    let r = op_addrcvrs(&raw, 2, CoilMode::Gls, Some(&ccg), false).unwrap();
    rel("gls weights", &r.coilcombos.w, &v.cvec("ccg_w"), 1e-9);
    compare("addrcvrs_gls", &r.out, &load(&d.join("addrcvrs_gls")), 1e-9);

    let r = op_addrcvrs(&raw, 1, CoilMode::W, None, true).unwrap();
    close("self w phases", &r.coilcombos.ph, &v.vec("ccw_self_ph"), 1e-9);
    close("self w weights", &re(&r.coilcombos.sig), &v.vec("ccw_self_sig"), 1e-12);
    compare("addrcvrs_w_self", &r.out, &load(&d.join("addrcvrs_w_self")), 1e-12);
    assert_eq!(r.fids_presum.as_ref().unwrap().len(), raw.fids.len());
    let r = op_addrcvrs(&raw, 1, CoilMode::H, None, false).unwrap();
    close("self h weights", &re(&r.coilcombos.sig), &v.vec("cch_self_sig"), 1e-12);
    compare("addrcvrs_h_self", &r.out, &load(&d.join("addrcvrs_h_self")), 1e-12);

    let (o, cc) = op_alignrcvrs(&raw, 1, CoilMode::W, None).unwrap();
    close("alignrcvrs phases", &cc.ph, &v.vec("alignrcvrs_ph"), 1e-9);
    compare("alignrcvrs_w", &o, &load(&d.join("alignrcvrs_w")), 1e-12);

    let c = op_combine_rcvrs(&raw, &raww).unwrap();
    close("combineRcvrs weights", &re(&c.weights.sig), &v.vec("combineRcvrs_sig"), 1e-12);
    compare("combineRcvrs_out", &c.out, &load(&d.join("combineRcvrs_out")), 1e-12);
    compare("combineRcvrs_outw", &c.outw, &load(&d.join("combineRcvrs_outw")), 1e-12);
    compare("combineRcvrs_out_presum", &c.out_presum, &load(&d.join("combineRcvrs_out_presum")), 1e-12);
}

#[test]
fn averages_ops() {
    let Some(d) = data_dir("single_ops") else { return };
    let v = Values::load(&d.join("values.json"));
    let out_cc = load(&d.join("out_cc"));
    // FID-A's frequency-domain branch fails ('tmax' undefined); record that.
    assert!(v.0["rmbad_f_error"].as_str().unwrap().contains("tmax"));
    let r = op_rmbadaverages(&out_cc, 1.5, Domain::Time).unwrap();
    let m = v.vec("rmbad_t15_metric");
    let scale = m.iter().fold(0.0f64, |a, b| a.max(b.abs()));
    close("rmbadaverages metric (relative)", &r.metric.iter().map(|x| x / scale).collect::<Vec<_>>(), &m.iter().map(|x| x / scale).collect::<Vec<_>>(), 1e-12);
    assert_eq!(r.bad, idx(&v.vec("rmbad_t15_bad")));
    compare("rmbad_t15", &r.out, &load(&d.join("rmbad_t15")), 1e-12);
    assert!(op_rmbadaverages(&out_cc, 2.0, Domain::Freq).is_ok());
    let r = op_rmworstaverage(&out_cc).unwrap();
    let m = v.vec("rmworst_metric");
    let scale = m.iter().fold(0.0f64, |a, b| a.max(b.abs()));
    close("rmworstaverage metric (relative)", &r.metric.iter().map(|x| x / scale).collect::<Vec<_>>(), &m.iter().map(|x| x / scale).collect::<Vec<_>>(), 1e-12);
    assert_eq!(r.bad, idx(&v.vec("rmworst_bad")));
    compare("rmworst", &r.out, &load(&d.join("rmworst")), 1e-12);
    compare("median", &op_median(&out_cc), &load(&d.join("median")), 1e-15);
    compare("takeaverages_135", &op_takeaverages(&out_cc, &[0, 2, 4]).unwrap(), &load(&d.join("takeaverages_135")), 0.0 + 1e-300);
    compare("takeaverages_2", &op_takeaverages(&out_cc, &[1]).unwrap(), &load(&d.join("takeaverages_2")), 1e-300);
}

#[test]
fn alignment_variants() {
    let Some(d) = data_dir("single_ops") else { return };
    let v = Values::load(&d.join("values.json"));
    let out_cc = load(&d.join("out_cc"));
    let a = op_align_averages(&out_cc, Some(0.2), AlignTo::Average).unwrap();
    close("alignAverages 'a' fs", &a.fs, &v.vec("aa_a_fs"), 1e-5);
    close("alignAverages 'a' phs", &a.phs, &v.vec("aa_a_phs"), 1e-4);
    compare("aa_a", &a.out, &load(&d.join("aa_a")), 1e-6);
    let a = op_align_averages(&out_cc, None, AlignTo::Best).unwrap();
    close("alignAverages (tmax estimated) fs", &a.fs, &v.vec("aa_auto_fs"), 1e-5);
    close("alignAverages (tmax estimated) phs", &a.phs, &v.vec("aa_auto_phs"), 1e-4);
    compare("aa_auto", &a.out, &load(&d.join("aa_auto")), 1e-6);
    let a = op_align_averages_fd(&out_cc, 1.6, 4.0, 0.25, AlignTo::Best).unwrap();
    close("alignAverages_fd 'n' fs", &a.fs, &v.vec("aafd_n_fs"), 1e-5);
    close("alignAverages_fd 'n' phs", &a.phs, &v.vec("aafd_n_phs"), 1e-4);
    compare("aafd_n", &a.out, &load(&d.join("aafd_n")), 1e-6);
    let a = op_freq_align_averages(&out_cc, 0.2, true, None).unwrap();
    close("freqAlignAverages 'y' fs", &a.fs, &v.vec("faa_y_fs"), 1e-5);
    compare("faa_y", &a.out, &load(&d.join("faa_y")), 1e-6);
    let a = op_freq_align_averages(&out_cc, 0.2, false, None).unwrap();
    close("freqAlignAverages 'n' fs", &a.fs, &v.vec("faa_n_fs"), 1e-5);
    compare("faa_n", &a.out, &load(&d.join("faa_n")), 1e-6);
}

#[test]
fn single_spectrum_ops() {
    let Some(d) = data_dir("single_ops") else { return };
    let v = Values::load(&d.join("values.json"));
    let s = load(&d.join("out_ls"));
    compare("timerange", &op_timerange(&s, 0.01, 0.5).unwrap(), &load(&d.join("timerange")), 1e-15);
    compare("freqrange", &op_freqrange(&s, 1.0, 4.0).unwrap(), &load(&d.join("freqrange")), 1e-12);
    compare("addphase", &op_addphase(&s, 30.0, 0.0005, 4.65), &load(&d.join("addphase")), 1e-12);
    compare("zeropad", &op_zeropad(&s, 2.5), &load(&d.join("zeropad")), 1e-15);
    compare("filter", &op_filter(&s, 3.0), &load(&d.join("filter")), 1e-14);
    compare("ampscale", &op_amp_scale(&s, 2.5), &load(&d.join("ampscale")), 1e-15);
    compare("complexconj", &op_complex_conj(&s), &load(&d.join("complexconj")), 1e-15);
    compare("freqshift", &op_freqshift(&s, 3.3), &load(&d.join("freqshift")), 1e-12);
    let (o, ph) = op_autophase(&s, 1.9, 2.1, 0.0, None).unwrap();
    close("autophase", &[ph], &[v.f("autophase_ph")], 1e-9);
    compare("autophase", &o, &load(&d.join("autophase")), 1e-12);
    let (o, f) = op_ppmref(&s, 1.9, 2.1, 2.01, None).unwrap();
    close("ppmref", &[f], &[v.f("ppmref_f")], 1e-9);
    compare("ppmref", &o, &load(&d.join("ppmref")), 1e-12);
    let snr = op_get_snr(&s, 1.8, 2.2, -2.0, 0.0).unwrap();
    close("SNR (relative)", &[snr.snr / v.f("snr")], &[1.0], 1e-10);
    close("SNR signal (relative)", &[snr.signal / v.f("snr_signal")], &[1.0], 1e-10);
    let w = load(&d.join("outw_ls"));
    close("linewidth", &[op_get_lw(&w, 4.4, 5.0, 8.0).unwrap()], &[v.f("lw")], 1e-6);
    close("linewidth (4-6 ppm, zp 4)", &[op_get_lw(&w, 4.0, 6.0, 4.0).unwrap()], &[v.f("lw_zp4")], 1e-6);
    let (o, ow) = op_ecc(&s, &w).unwrap();
    compare("ecc", &o, &load(&d.join("ecc")), 1e-12);
    compare("ecc_w", &ow, &load(&d.join("ecc_w")), 1e-12);
}

fn sorted(mut v: Vec<f64>) -> Vec<f64> {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v
}

#[test]
fn hsvd_water_removal() {
    let Some(d) = data_dir("single_ops") else { return };
    let v = Values::load(&d.join("values.json"));
    let s = load(&d.join("out_ls"));
    let t0 = std::time::Instant::now();
    let r = op_remove_water(&s, [4.4, 5.0], 30, None).unwrap();
    eprintln!("op_removeWater on {} points: {:.2} s", s.n(), t0.elapsed().as_secs_f64());
    assert_eq!(r.components.k, v.f("rw_k") as usize);
    let want = sorted(v.vec("rw_water_wppm"));
    let got = sorted(r.components.ppm.clone());
    eprintln!("water components: {} vs FID-A {}", got.len(), want.len());
    assert_eq!(got.len(), want.len());
    close("water component ppm", &got, &want, 1e-4);
    // Model spectrum against FID-A's model.specs and the water-removed data.
    let model_spec = spec(&r.model.fids);
    rel("water model spectrum", &model_spec, &v.cvec("rw_model_specs"), 1e-7);
    let want_out = load(&d.join("removewater"));
    let e = rel_err(&r.out.fids, &want_out.fids);
    eprintln!("water-removed FID relative difference {e:.2e} (residual error {} vs {})", r.components.residual_error, v.f("rw_residual_error"));
    assert!(e < 1e-7);
    let h = op_hsvd_fit(&s, [0.2, 4.2], 30, None).unwrap();
    rel("HSVD model spectrum", &spec(&h.model.fids), &v.cvec("hsvd_model_specs"), 1e-7);
    let e = rel_err(&h.out.fids, &load(&d.join("hsvdfit_resid")).fids);
    eprintln!("HSVD residual relative difference {e:.2e}");
    assert!(e < 1e-7);
}

#[test]
fn subspectra_ops() {
    let Some(d) = data_dir("single_ops") else { return };
    let v = Values::load(&d.join("values.json"));
    let sw_cc = load(&d.join("sw_cc"));
    let sw_av = load(&d.join("sw_av"));
    compare("averaging", &op_averaging(&sw_cc), &sw_av, 1e-15);
    compare("takesubspec_2", &op_takesubspec(&sw_av, &[1]).unwrap(), &load(&d.join("takesubspec_2")), 1e-300);
    compare("combinesubspecs_summ", &op_combinesubspecs(&sw_av, CombineMode::Summ).unwrap(), &load(&d.join("combinesubspecs_summ")), 1e-15);
    compare("combinesubspecs_diff", &op_combinesubspecs(&sw_cc, CombineMode::Diff).unwrap(), &load(&d.join("combinesubspecs_diff")), 1e-15);
    let (o, f, p) = op_align_mp_subspecs(&sw_av, false, None, None).unwrap();
    close("alignMPSubspecs 'o'", &[f, p], &v.vec("alignmp_o"), 1e-4);
    compare("alignmp_o", &o, &load(&d.join("alignmp_o")), 1e-6);
    let (o, f, p) = op_align_mp_subspecs(&sw_av, true, None, None).unwrap();
    close("alignMPSubspecs 'i'", &[f, p], &v.vec("alignmp_i"), 1e-4);
    compare("alignmp_i", &o, &load(&d.join("alignmp_i")), 1e-6);
    let a = op_align_isis(&sw_av, 0.4, None).unwrap();
    close("alignISIS without averages", &[a.fs[0], a.phs[0]], &v.vec("alignisis_noavg"), 1e-9);
    compare("alignisis_noavg", &a.out, &load(&d.join("alignisis_noavg")), 1e-12);
    let fs4 = load(&d.join("fourstep_in"));
    for mode in 0..4u8 {
        compare(&format!("fourstep_{mode}"), &op_four_step_combine(&fs4, mode).unwrap(), &load(&d.join(format!("fourstep_{mode}"))), 1e-15);
    }
}

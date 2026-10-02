% REF_OPS  FID-A reference for the individual ops (tests/ref_ops.rs).
%   FIDA_TEST_DATA=... octave-cli ref_ops.m
%   Runs the ops the pipelines do not exercise (other modes and arguments)
%   on the GE PRESS example and the SPECIAL water reference, exporting
%   inputs and outputs to $FIDA_TEST_DATA/ops/single_ops/.
root = fida_setup();
ex = getenv('FIDA_EXAMPLES');
if isempty(ex)
  ex = '/home/ubuntu/src/mrs/FID-A/exampleData';
end
d = fullfile(root, 'single_ops');
mkdir(d);
E = @(s, name) export_fida(s, fullfile(d, name));
V = struct();

[raw, raww] = io_loadspec_GE(fullfile(ex, 'GE', 'sample01_press', 'press', 'P17920.7'), 1);
raw = op_complexConj(raw);
raww = op_complexConj(raww);
E(raw, 'raw');
E(raww, 'raww');

% Coil combination modes.
cch = op_getcoilcombos(raww, 1, 'h');
V.cch_ph = cch.ph;
V.cch_sig = cch.sig;
[o, ~, ~, used] = op_addrcvrs(raw, 1, 'h', cch);
E(o, 'addrcvrs_h');
V.cch_used_sig = used.sig;
ccg = op_getcoilcombos(raww, 2, 'gls');
V.ccg_sig = ccg.sig;
[o, ~, ~, used] = op_addrcvrs(raw, 2, 'gls', ccg);
E(o, 'addrcvrs_gls');
V.ccg_w = used.w;
[o, ~, ~, used] = op_addrcvrs(raw, 1, 'w');
E(o, 'addrcvrs_w_self');
V.ccw_self_ph = used.ph;
V.ccw_self_sig = used.sig;
[o, ~, ~, used] = op_addrcvrs(raw, 1, 'h');
E(o, 'addrcvrs_h_self');
V.cch_self_sig = used.sig;
[o, cca] = op_alignrcvrs(raw, 1, 'w');
E(o, 'alignrcvrs_w');
V.alignrcvrs_ph = cca.ph;
[co, cow, cop, cowp, wts] = op_combineRcvrs(raw, raww);
E(co, 'combineRcvrs_out');
E(cow, 'combineRcvrs_outw');
E(cop, 'combineRcvrs_out_presum');
V.combineRcvrs_sig = wts.sig;

out_cc = op_addrcvrs(raw, 1, 'w', op_getcoilcombos(raww, 1));
E(out_cc, 'out_cc');
outw_cc = op_addrcvrs(raww, 1, 'w', op_getcoilcombos(raww, 1));
E(outw_cc, 'outw_cc');

% Averages.
try
  [o, m, b] = op_rmbadaverages(out_cc, 2, 'f');
  E(o, 'rmbad_f');
  V.rmbad_f_metric = m;
  V.rmbad_f_bad = b;
catch err
  V.rmbad_f_error = err.message;
end
[o, m, b] = op_rmbadaverages(out_cc, 1.5, 't');
E(o, 'rmbad_t15');
V.rmbad_t15_metric = m;
V.rmbad_t15_bad = b;
[o, m, b] = op_rmworstaverage(out_cc);
E(o, 'rmworst');
V.rmworst_metric = m;
V.rmworst_bad = b;
E(op_median(out_cc), 'median');
E(op_takeaverages(out_cc, [1 3 5]), 'takeaverages_135');
E(op_takeaverages(out_cc, 2), 'takeaverages_2');

% Alignment variants.
[o, fs, phs] = op_alignAverages(out_cc, 0.2, 'a');
E(o, 'aa_a');
V.aa_a_fs = fs;
V.aa_a_phs = phs;
[o, fs, phs] = op_alignAverages(out_cc);
E(o, 'aa_auto');
V.aa_auto_fs = fs;
V.aa_auto_phs = phs;
[o, fs, phs] = op_alignAverages_fd(out_cc, 1.6, 4, 0.25, 'n');
E(o, 'aafd_n');
V.aafd_n_fs = fs;
V.aafd_n_phs = phs;
[o, fs] = op_freqAlignAverages(out_cc, 0.2, 'y');
E(o, 'faa_y');
V.faa_y_fs = fs;
[o, fs] = op_freqAlignAverages(out_cc, 0.2, 'n');
E(o, 'faa_n');
V.faa_n_fs = fs;

% Single-spectrum ops.
out_av = op_averaging(out_cc);
out_ls = op_leftshift(out_av, out_av.pointsToLeftshift);
E(out_ls, 'out_ls');
outw_ls = op_leftshift(op_averaging(outw_cc), outw_cc.pointsToLeftshift);
E(outw_ls, 'outw_ls');
E(op_timerange(out_ls, 0.01, 0.5), 'timerange');
E(op_freqrange(out_ls, 1, 4), 'freqrange');
E(op_addphase(out_ls, 30, 0.0005), 'addphase');
E(op_zeropad(out_ls, 2.5), 'zeropad');
E(op_filter(out_ls, 3), 'filter');
E(op_ampScale(out_ls, 2.5), 'ampscale');
E(op_complexConj(out_ls), 'complexconj');
E(op_freqshift(out_ls, 3.3), 'freqshift');
[o, ph] = op_autophase(out_ls, 1.9, 2.1);
E(o, 'autophase');
V.autophase_ph = ph;
[o, f] = op_ppmref(out_ls, 1.9, 2.1, 2.01);
E(o, 'ppmref');
V.ppmref_f = f;
[V.snr, V.snr_signal, V.snr_noisesd] = op_getSNR(out_ls, 1.8, 2.2, -2, 0, true);
V.lw = op_getLW(outw_ls, 4.4, 5.0, 8, true);
V.lw_zp4 = op_getLW(outw_ls, 4, 6, 4, true);
[o, K, wppm, amp, alpha, ph, model] = op_removeWater(out_ls);
E(o, 'removewater');
E(model, 'removewater_model_raw');
V.rw_k = K;
V.rw_wppm = wppm;
V.rw_amp = amp;
V.rw_alpha = alpha;
V.rw_water_wppm = o.watersupp.wppm;
V.rw_residual_error = o.watersupp.residual_error;
V.rw_model_specs = model.specs;
[model, resid, K, ppms] = op_HSVDfit(out_ls);
E(resid, 'hsvdfit_resid');
V.hsvd_k = K;
V.hsvd_ppms = ppms;
V.hsvd_model_specs = model.specs;
[o, ow] = op_ecc_klose(out_ls, outw_ls);
E(o, 'ecc');
E(ow, 'ecc_w');

% Subspectra from the SPECIAL water reference (double precision).
sp = fullfile(ex, 'Siemens', 'sample02_special');
sw = io_loadspec_twix(fullfile(sp, 'special_w', 'specialDLPFC_w.dat'));
sw.fids = double(sw.fids);
sw_cc = op_addrcvrs(sw, 2, 'w', op_getcoilcombos(op_combinesubspecs(sw, 'diff'), 2));
E(sw_cc, 'sw_cc');
sw_av = op_averaging(sw_cc);
E(sw_av, 'sw_av');
E(op_takesubspec(sw_av, 2), 'takesubspec_2');
E(op_combinesubspecs(sw_av, 'summ'), 'combinesubspecs_summ');
E(op_combinesubspecs(sw_cc, 'diff'), 'combinesubspecs_diff');
[o, fs, phs] = op_alignMPSubspecs(sw_av);
E(o, 'alignmp_o');
V.alignmp_o = [fs phs];
[o, fs, phs] = op_alignMPSubspecs(sw_av, 'i');
E(o, 'alignmp_i');
V.alignmp_i = [fs phs];
[o, fs, phs] = op_alignISIS(sw_av, 0.4);
E(o, 'alignisis_noavg');
V.alignisis_noavg = [fs phs];

% Four-step data: four subspectra built from the two SPECIAL ones.
fs4 = sw_av;
fs4.fids = cat(2, sw_av.fids(:, 1), sw_av.fids(:, 2), 0.5 * sw_av.fids(:, 1), 2 * sw_av.fids(:, 2) + 1e-3i);
fs4.sz = size(fs4.fids);
fs4.subspecs = 4;
fs4.flags.isFourSteps = 1;
E(fs4, 'fourstep_in');
for mode = 0:3
  E(op_fourStepCombine(fs4, mode), sprintf('fourstep_%d', mode));
end

export_values(V, fullfile(d, 'values'));
disp('ref_ops done');

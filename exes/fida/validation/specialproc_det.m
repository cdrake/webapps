function [out, out_w, out_noproc, out_w_noproc] = specialproc_det(out_raw, out_w_raw, outdir)
% SPECIALPROC_DET  run_specialproc_auto.m with its random draws fixed, no plots.
%   FID-A's run_specialproc_auto (aaDomain 'f', tmaxin 0.2, iterin 20) line
%   for line, from loaded structures (out_w_raw may be struct()). Where the
%   script draws tmax=tmaxin+0.04*randn, fmin=1.8+0.1*randn and fmax from
%   {2.4,2.85,3.35,4.2,4.4,5.2}, this uses tmax=0.2, fmin=1.8, fmax=4.2 on
%   every iteration, as exes/fida/src/ops/pipeline.rs does. Without water
%   the script calls op_getcoilcombos_specReg, which is not ported; this
%   requires the water reference.
  iterin = 20;
  tmax = 0.2;
  fmin = 1.8;
  fmax = 4.2;
  if ~exist(outdir, 'dir')
    mkdir(outdir);
  end
  ex = @(s, name) export_fida(s, fullfile(outdir, name));
  V = struct();
  water = isstruct(out_w_raw) && ~isempty(fieldnames(out_w_raw));
  if ~water
    error('specialproc_det needs the water reference');
  end

  coilcombos = op_getcoilcombos(op_combinesubspecs(out_w_raw, 'diff'), 2);
  V.cc_ph = coilcombos.ph;
  V.cc_sig = coilcombos.sig;
  [out_cc, fid_pre, spec_pre] = op_addrcvrs(out_raw, 2, 'w', coilcombos);
  [out_w_cc, fid_w_pre, spec_w_pre] = op_addrcvrs(out_w_raw, 2, 'w', coilcombos);
  clear fid_pre spec_pre fid_w_pre spec_w_pre;
  ex(out_cc, 'out_cc');
  ex(out_w_cc, 'out_w_cc');

  out_noproc = op_combinesubspecs(op_averaging(out_cc), 'diff');
  out_w_noproc = op_combinesubspecs(op_averaging(out_w_cc), 'diff');

  % Alignment of the subspectra: averages, ISIS, averages, ISIS.
  [out_ai, fs_temp, phs_temp] = op_alignAverages(out_cc, 0.4, 'y');
  V.ai1_fs = fs_temp;
  V.ai1_phs = phs_temp;
  ex(out_ai, 'out_ai1');
  fs_ai = fs_temp;
  phs_ai = phs_temp;
  [out_ai, fs_temp, phs_temp] = op_alignISIS(out_ai, 0.4);
  V.ai2_fs = fs_temp;
  V.ai2_phs = phs_temp;
  ex(out_ai, 'out_ai2');
  fs_ai(:, 2) = fs_ai(:, 2) + fs_temp;
  phs_ai(:, 2) = phs_ai(:, 2) + phs_temp;
  [out_ai, fs_temp, phs_temp] = op_alignAverages(out_ai, 0.4, 'y');
  V.ai3_fs = fs_temp;
  V.ai3_phs = phs_temp;
  ex(out_ai, 'out_ai3');
  fs_ai = fs_ai + fs_temp;
  phs_ai = phs_ai + phs_temp;
  [out_ai, fs_temp, phs_temp] = op_alignISIS(out_ai, 0.4);
  V.ai4_fs = fs_temp;
  V.ai4_phs = phs_temp;
  ex(out_ai, 'out_ai4');
  fs_ai(:, 2) = fs_ai(:, 2) + fs_temp;
  phs_ai(:, 2) = phs_ai(:, 2) + phs_temp;
  fs_ai = mean(fs_ai, 2);
  phs_ai = mean(phs_ai, 2);

  [out_w_ai, fs_w_temp, phs_w_temp] = op_alignAverages(out_w_cc, 0.4, 'y');
  [out_w_ai, fs_w_temp, phs_w_temp] = op_alignISIS(out_w_ai, 0.4);
  [out_w_ai, fs_w_temp, phs_w_temp] = op_alignAverages(out_w_ai, 0.4, 'y');
  [out_w_ai, fs_w_temp, phs_w_temp] = op_alignISIS(out_w_ai, 0.4);
  ex(out_w_ai, 'out_w_ai');

  out_cs = op_combinesubspecs(out_ai, 'diff');
  out_w_cs = op_combinesubspecs(out_w_ai, 'diff');
  ex(out_cs, 'out_cs');
  ex(out_w_cs, 'out_w_cs');

  % Removal of bad averages (nsd = 3, time domain), iterated until none.
  nsd = 3;
  iter = 1;
  nbadAverages = 1;
  nBadAvgTotal = 0;
  allAveragesLeft = [1:out_cs.sz(out_cs.dims.averages)]';
  allBadAverages = [];
  out_cs2 = out_cs;
  while nbadAverages > 0
    [out_rm, metric, badAverages] = op_rmbadaverages(out_cs2, nsd, 't');
    V.(sprintf('rm_metric_%d', iter)) = metric;
    V.(sprintf('rm_bad_%d', iter)) = badAverages;
    allBadAverages = [allBadAverages; allAveragesLeft(badAverages)];
    badavMask_temp = zeros(length(allAveragesLeft), 1);
    badavMask_temp(badAverages) = 1;
    allAveragesLeft = allAveragesLeft(~badavMask_temp);
    nbadAverages = numel(badAverages);
    nBadAvgTotal = nBadAvgTotal + nbadAverages;
    out_cs2 = out_rm;
    iter = iter + 1;
  end
  V.rm_iterations = iter - 1;
  V.rm_total = nBadAvgTotal;
  V.rm_all_bad = allBadAverages;
  ex(out_rm, 'out_rm');
  BadAvgMask = zeros(length(fs_ai), 1);
  BadAvgMask(allBadAverages) = 1;
  fs_ai = fs_ai(~BadAvgMask);
  phs_ai = phs_ai(~BadAvgMask);

  % Drift correction.
  out_rm2 = out_rm;
  fsPoly = 100;
  phsPoly = 1000;
  fsCum = fs_ai;
  phsCum = phs_ai;
  iter = 1;
  while (abs(fsPoly(1)) > 0.001 || abs(phsPoly(1)) > 0.01) && iter < iterin
    [out_aa, fs, phs] = op_alignAverages_fd(out_rm2, fmin, fmax, tmax, 'n');
    [out_w_aa, fs_w, phs_w] = op_alignAverages(out_w_cs, 5 * tmax, 'n');
    fsCum = fsCum + fs;
    phsCum = phsCum + phs;
    fsPoly = polyfit([1:out_aa.sz(out_aa.dims.averages)]', fs, 1);
    phsPoly = polyfit([1:out_aa.sz(out_aa.dims.averages)]', phs, 1);
    V.(sprintf('aa_fs_%d', iter)) = fs;
    V.(sprintf('aa_phs_%d', iter)) = phs;
    V.(sprintf('aaw_fs_%d', iter)) = fs_w;
    V.(sprintf('aaw_phs_%d', iter)) = phs_w;
    ex(out_aa, sprintf('out_aa_%d', iter));
    out_rm2 = out_aa;
    out_w_cs = out_w_aa;
    iter = iter + 1;
  end
  V.aa_iterations = iter - 1;
  V.fscum = fsCum;
  V.phscum = phsCum;
  ex(out_w_aa, 'out_w_aa');

  out_av = op_leftshift(op_averaging(out_aa), out_aa.pointsToLeftshift);
  out_w_av = op_leftshift(op_averaging(out_w_aa), out_w_aa.pointsToLeftshift);
  ex(out_av, 'out_av');
  ex(out_w_av, 'out_w_av');

  out_av_zp = op_zeropad(out_av, 16);
  index = find(abs(out_av_zp.specs) == max(abs(out_av_zp.specs(out_av_zp.ppm > 2.85 & out_av_zp.ppm < 3.15, 1))));
  ph0 = -phase(out_av_zp.specs(index, 1)) * 180 / pi;
  V.ph0 = ph0;
  out_ph = op_addphase(out_av, ph0);
  out_noproc = op_addphase(op_leftshift(out_noproc, out_noproc.pointsToLeftshift), ph0);
  out_w_av_zp = op_zeropad(out_w_av, 16);
  indexw = find(abs(out_w_av_zp.specs) == max(abs(out_w_av_zp.specs(out_w_av_zp.ppm > 4 & out_w_av_zp.ppm < 5.5))));
  ph0w = -phase(out_w_av_zp.specs(indexw)) * 180 / pi;
  V.ph0w = ph0w;
  out_w_ph = op_addphase(out_w_av, ph0w);
  out_w_noproc = op_addphase(op_leftshift(out_w_noproc, out_w_noproc.pointsToLeftshift), ph0w);
  out_w_ph_zp = op_addphase(out_w_av_zp, ph0w);

  [~, frqShift] = op_ppmref(out_av_zp, 2.9, 3.1, 3.027);
  V.frqShift = frqShift;
  out = op_freqshift(out_ph, frqShift);
  out_noproc = op_freqshift(out_noproc, frqShift);
  [~, frqShiftw] = op_ppmref(out_w_ph_zp, 4, 5.5, 4.65);
  V.frqShiftw = frqShiftw;
  out_w = op_freqshift(out_w_ph, frqShiftw);
  out_w_noproc = op_freqshift(out_w_noproc, frqShiftw);
  ex(out, 'out');
  ex(out_noproc, 'out_noproc');
  ex(out_w, 'out_w');
  ex(out_w_noproc, 'out_w_noproc');

  V = quality_values(V, out, out_w, true);
  export_values(V, fullfile(outdir, 'values'));
end

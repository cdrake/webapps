function [out, outw, out_noproc, outw_noproc] = pressproc_det(raw, raww, outdir, ge)
  % ge = true: run_pressproc_GEauto's phasing (residual water, no filter,
  % the water reference gets the metabolite phase).
  if nargin < 4
    ge = false;
  end
% PRESSPROC_DET  run_pressproc_auto.m with its random draws fixed, no plots.
%   The processing is FID-A's run_pressproc_auto (aaDomain 'f', iterin 20)
%   line for line, starting from already-loaded structures (raww may be
%   struct() when there is no water reference). Where the script draws
%     tmax=0.25+0.03*randn, ppmmin=1.6+0.1*randn, ppmmax from {3.5,4,5.5}+0.1*randn
%   this uses tmax=0.25, ppmmin=1.6, ppmmax=4.0 on every iteration, as
%   exes/fida/src/ops/pipeline.rs does. Every intermediate structure is
%   written to outdir with export_fida; scalars and vectors go to
%   outdir/values.json.
  iterin = 20;
  tmax = 0.25;
  ppmmin = 1.6;
  ppmmax = 4.0;
  if ~exist(outdir, 'dir')
    mkdir(outdir);
  end
  ex = @(s, name) export_fida(s, fullfile(outdir, name));
  V = struct();
  water = isstruct(raww) && ~isempty(fieldnames(raww));

  if water
    coilcombos = op_getcoilcombos(raww, 1);
    [outw_cc, fidw_pre, specw_pre] = op_addrcvrs(raww, 1, 'w', coilcombos);
    ex(outw_cc, 'outw_cc');
  else
    coilcombos = op_getcoilcombos(op_averaging(raw), 1);
  end
  V.cc_ph = coilcombos.ph;
  V.cc_sig = coilcombos.sig;
  [out_cc, fid_pre, spec_pre, cc_used] = op_addrcvrs(raw, 1, 'w', coilcombos);
  V.cc_used_sig = cc_used.sig;
  ex(out_cc, 'out_cc');

  out_noproc = op_averaging(out_cc);
  if water
    outw_noproc = op_averaging(outw_cc);
  end

  % Removal of bad averages (nsd = 4, time domain), iterated until none.
  nsd = 4;
  iter = 1;
  nbadAverages = 1;
  nBadAvgTotal = 0;
  out_cc2 = out_cc;
  while nbadAverages > 0
    [out_rm, metric, badAverages] = op_rmbadaverages(out_cc2, nsd, 't');
    V.(sprintf('rm_metric_%d', iter)) = metric;
    V.(sprintf('rm_bad_%d', iter)) = badAverages;
    nbadAverages = length(badAverages);
    nBadAvgTotal = nBadAvgTotal + nbadAverages;
    out_cc2 = out_rm;
    iter = iter + 1;
  end
  V.rm_iterations = iter - 1;
  V.rm_total = nBadAvgTotal;
  ex(out_rm, 'out_rm');

  % Drift correction.
  if water
    [outw_aa, fsw, phsw] = op_alignAverages(outw_cc, 0.2, 'n');
    V.aaw_fs = fsw;
    V.aaw_phs = phsw;
    ex(outw_aa, 'outw_aa');
  end
  out_rm2 = out_rm;
  fsPoly = 100;
  phsPoly = 1000;
  fscum = zeros(out_rm2.sz(out_rm2.dims.averages), 1);
  phscum = zeros(out_rm2.sz(out_rm2.dims.averages), 1);
  iter = 1;
  while (abs(fsPoly(1)) > 0.001 || abs(phsPoly(1)) > 0.01) && iter < iterin
    iter = iter + 1;
    [out_aa, fs, phs] = op_alignAverages_fd(out_rm2, ppmmin, ppmmax, tmax, 'y');
    fsPoly = polyfit([1:out_aa.sz(out_aa.dims.averages)]', fs, 1);
    phsPoly = polyfit([1:out_aa.sz(out_aa.dims.averages)]', phs, 1);
    V.(sprintf('aa_fs_%d', iter - 1)) = fs;
    V.(sprintf('aa_phs_%d', iter - 1)) = phs;
    V.(sprintf('aa_fspoly_%d', iter - 1)) = fsPoly;
    V.(sprintf('aa_phspoly_%d', iter - 1)) = phsPoly;
    ex(out_aa, sprintf('out_aa_%d', iter - 1));
    fscum = fscum + fs;
    phscum = phscum + phs;
    out_rm2 = out_aa;
  end
  V.aa_iterations = iter - 1;
  V.fscum = fscum;
  V.phscum = phscum;
  out_av = op_averaging(out_aa);
  ex(out_av, 'out_av');
  if water
    outw_av = op_averaging(outw_aa);
    ex(outw_av, 'outw_av');
  end

  out_ls = op_leftshift(out_av, out_av.pointsToLeftshift);
  ex(out_ls, 'out_ls');
  if water
    outw_ls = op_leftshift(outw_av, outw_av.pointsToLeftshift);
  end

  if ge
    out_ls_zp_filt = op_zeropad(out_ls, 16);
    ex(out_ls_zp_filt, 'out_ls_zp_filt');
    [out_ls_zp_filt_ph, ph0] = op_autophase(out_ls_zp_filt, 4, 5.5);
  else
    out_ls_zp_filt = op_filter(op_zeropad(out_ls, 16), 5);
    ex(out_ls_zp_filt, 'out_ls_zp_filt');
    [out_ls_zp_filt_ph, ph0] = op_autophase(out_ls_zp_filt, 2.9, 3.1);
  end
  ex(out_ls_zp_filt_ph, 'out_ls_zp_filt_ph');
  V.ph0 = ph0;
  out_ls_ph = op_addphase(out_ls, ph0);
  if water
    if ge
      ph0w = ph0;
      outw_ls_zp_filt_ph = op_addphase(op_zeropad(outw_ls, 16), ph0);
    else
      outw_ls_zp_filt = op_filter(op_zeropad(outw_ls, 16), 5);
      [outw_ls_zp_filt_ph, ph0w] = op_autophase(outw_ls_zp_filt, 4, 5.5);
    end
    V.ph0w = ph0w;
    outw_ls_ph = op_addphase(outw_ls, ph0w);
  end

  out_noproc = op_addphase(op_leftshift(out_noproc, out_noproc.pointsToLeftshift), ph0);
  if water
    outw_noproc = op_addphase(op_leftshift(outw_noproc, outw_noproc.pointsToLeftshift), ph0w);
  end

  [~, frqShift] = op_ppmref(out_ls_zp_filt_ph, 2.9, 3.1, 3.027);
  V.frqShift = frqShift;
  out = op_freqshift(out_ls_ph, frqShift);
  out_noproc = op_freqshift(out_noproc, frqShift);
  ex(out, 'out');
  ex(out_noproc, 'out_noproc');
  if water
    [~, frqShiftw] = op_ppmref(outw_ls_zp_filt_ph, 4, 5.5, 4.65);
    V.frqShiftw = frqShiftw;
    outw = op_freqshift(outw_ls_ph, frqShiftw);
    outw_noproc = op_freqshift(outw_noproc, frqShiftw);
    ex(outw, 'outw');
    ex(outw_noproc, 'outw_noproc');
  else
    outw = struct();
    outw_noproc = struct();
  end

  V = quality_values(V, out, outw, water);
  export_values(V, fullfile(outdir, 'values'));
end

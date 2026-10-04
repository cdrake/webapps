function [diffSpec, sumSpec, subSpec1, subSpec2, outw] = megapressproc_det(raw, raww, outdir)
% MEGAPRESSPROC_DET  run_megapressproc_auto.m with its random draws fixed, no plots.
%   FID-A's run_megapressproc_auto (avgAlignDomain 'f', alignSS 2) line for
%   line, from loaded structures (raww may be struct()). Where the script
%   draws tmax=0.25+0.03*randn, ppmmin=1.6+0.1*randn and ppmmax from
%   {3.5,4,5.5}+0.1*randn, this uses tmax=0.25, ppmmin=1.6, ppmmax=4.0 on
%   every iteration, as exes/fida/src/ops/pipeline.rs does. Intermediates go
%   to outdir with export_fida; scalars and vectors to outdir/values.json.
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
    outw_cc = op_addrcvrs(raww, 1, 'w', coilcombos);
    ex(outw_cc, 'outw_cc');
  else
    coilcombos = op_getcoilcombos(op_averaging(op_combinesubspecs(raw, 'summ')), 1);
  end
  V.cc_ph = coilcombos.ph;
  V.cc_sig = coilcombos.sig;
  out_cc = op_addrcvrs(raw, 1, 'w', coilcombos);
  ex(out_cc, 'out_cc');
  out_noproc = op_combinesubspecs(op_averaging(out_cc), 'diff');

  % Removal of bad averages (nsd = 4, time domain), iterated until none.
  nsd = 4;
  iter = 1;
  nbadAverages = 1;
  nBadAvgTotal = 0;
  out_cc2 = out_cc;
  while nbadAverages > 0
    [out_rm, metric, badAverages] = op_rmbadaverages(out_cc2, nsd, 't');
    V.(sprintf('rm_bad_%d', iter)) = badAverages;
    nbadAverages = length(badAverages) * raw.sz(raw.dims.subSpecs);
    nBadAvgTotal = nBadAvgTotal + nbadAverages;
    out_cc2 = out_rm;
    iter = iter + 1;
  end
  V.rm_total = nBadAvgTotal;
  ex(out_rm, 'out_rm');

  % Drift correction, per subspectrum.
  if water
    outw_aa = op_alignAverages(outw_cc, 0.2, 'n');
    ex(outw_aa, 'outw_aa');
  end
  out_rm2 = out_rm;
  iter = 0;
  p = 100;
  fscum = zeros(out_rm.sz(2:end));
  phscum = zeros(out_rm.sz(2:end));
  while abs(p(1)) > 0.0003 && iter < iterin
    iter = iter + 1;
    [out_aa, fs, phs] = op_alignAverages_fd(out_rm2, ppmmin, ppmmax, tmax, 'y');
    x = repmat([1:size(fs, 1)]', 1, out_aa.sz(out_aa.dims.subSpecs));
    p = polyfit(x, fs, 1);
    fscum = fscum + fs;
    phscum = phscum + phs;
    out_rm2 = out_aa;
  end
  V.aa_iterations = iter;
  V.fscum = fscum;
  V.phscum = phscum;
  out_av = op_averaging(out_aa);
  ex(out_av, 'out_av');
  if water
    outw_av = op_averaging(outw_aa);
  end

  out_ls = op_leftshift(out_av, out_av.pointsToLeftshift);
  if water
    outw_ls = op_leftshift(outw_av, outw_av.pointsToLeftshift);
  end
  out_ls_ss2 = op_takesubspec(out_ls, 2);
  [~, ph0] = op_autophase(out_ls_ss2, 2.9, 3.1);
  V.ph0 = ph0;
  out_ph = op_addphase(out_ls, ph0);
  out_noproc = op_addphase(out_noproc, ph0);
  if out_ph.dims.subSpecs
    [out, fs_ss, phs_ss] = op_alignMPSubspecs(out_ph);
    V.ss_fs = fs_ss;
    V.ss_phs = phs_ss;
  else
    out = out_ph;
  end
  ex(out, 'out_as');
  if water
    if outw_ls.dims.subSpecs
      outw_as = op_alignMPSubspecs_fd(outw_ls, 3, 6.5, 'i');
    else
      outw_as = outw_ls;
    end
  end
  diffSpec = op_combinesubspecs(out, 'diff');
  sumSpec = op_combinesubspecs(out, 'summ');
  subSpec1 = op_takesubspec(out, 1);
  subSpec1 = op_addphase(subSpec1, 180);
  subSpec2 = op_takesubspec(out, 2);
  [subSpec1, frqShift] = op_ppmref(subSpec1, 2.9, 3.1, 3.027);
  V.frqShift = frqShift;
  diffSpec = op_freqshift(diffSpec, frqShift);
  sumSpec = op_freqshift(sumSpec, frqShift);
  subSpec2 = op_freqshift(subSpec2, frqShift);
  ex(diffSpec, 'diff');
  ex(sumSpec, 'sum');
  ex(subSpec1, 'sub1');
  ex(subSpec2, 'sub2');
  if water
    if outw_ls.dims.subSpecs
      outw = op_combinesubspecs(outw_as, 'diff');
    else
      outw = outw_ls;
    end
    outw = op_addphase(outw, -phase(outw.fids(1)) * 180 / pi, 0, 4.65, 1);
    ex(outw, 'outw');
  else
    outw = struct();
  end
  export_values(V, fullfile(outdir, 'values'));
end

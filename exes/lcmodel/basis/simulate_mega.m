% simulate_mega.m
% MEGA-PRESS basis spectra (edit-OFF, or the edit-ON minus edit-OFF
% difference) for the library.json sets whose sequence is MEGA-PRESS.
% Timing as FID-A's run_simMegaPressShaped.m: taus = [5 17 17 17 12] ms
% (TE 68 ms), editing at 1.88 ppm (ON) and 7.5 ppm (OFF).
% * simulation 'shaped-central' (the difference set): FID-A's shaped editing
%   and refocusing pulses at the voxel centre with the full phase cycle
%   (sim_megapress_central.m). Real 14 ms editing pulses nearly erase the
%   NAA singlet at 2.01 ppm in the edit-ON scan, which instantaneous pulses
%   cannot reproduce; the difference spectrum's large negative NAA, LCModel's
%   reference for MEGA-PRESS, needs the shaped pulses.
% * simulation 'ideal' (edit-OFF): FID-A's sim_megapress with instantaneous
%   pulses, each spin's editing flip angle taken from a Bloch simulation of
%   FID-A's sample editing pulse at its frequency.
%
%   FIDA=/path/to/FID-A OUT=/path/to/out octave --no-gui simulate_mega.m
%   (SET and METABOLITE restrict the run to one set or metabolite.)
%
% Writes $OUT/<set id>/<metabolite>.{json,bin} for the sets in library.json
% whose sequence is MEGA-PRESS (edit 'diff' = ON - OFF, or 'off').
warning('off', 'all');
here = fileparts(mfilename('fullpath'));
addpath(genpath(getenv('FIDA')));
addpath(here);
addpath(fullfile(here, '..', '..', 'fida', 'validation'));
outdir = getenv('OUT');
lib = jsondecode(fileread(fullfile(here, 'library.json')));
S = load('spinSystems.mat');
gamma = 42.577;
RF = io_loadRFwaveform('sampleEditPulse.pta', 'inv', 0);
pkg load signal;
for s = 1:numel(lib.mega)
  set = lib.mega(s);
  if iscell(set), set = set{1}; end
  if ~isempty(getenv('SET')) && ~strcmp(getenv('SET'), set.id), continue; end
  % Inversion profile of the editing pulse: Mz against offset (kHz).
  [mv, sc] = rf_blochSim(RF, set.edit_tp_ms, 1.0, 0);
  flip_at = @(hz) acosd(max(-1, min(1, interp1(sc * 1000, mv(3, :), hz, 'linear', 1))));
  d = fullfile(outdir, set.id);
  mkdir(d);
  for m = 1:numel(set.metabolites)
    name = set.metabolites{m};
    if ~isempty(getenv('METABOLITE')) && ~strcmp(getenv('METABOLITE'), name), continue; end
    sys = S.(['sys' name]);
    refoc = cell(1, numel(sys));
    on = cell(1, numel(sys));
    off = cell(1, numel(sys));
    for k = 1:numel(sys)
      refoc{k} = 180 * ones(1, numel(sys(k).shifts));
      on{k} = arrayfun(@(p) flip_at((p - set.edit_on_ppm) * set.field_T * gamma), sys(k).shifts(:)');
      off{k} = arrayfun(@(p) flip_at((p - set.edit_off_ppm) * set.field_T * gamma), sys(k).shifts(:)');
    end
    taus = set.taus_ms(:)';
    if strcmp(set.simulation, 'shaped-central')
      [son, soff] = sim_megapress_central(set, sys);
    else
      son = sim_megapress(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, sys, taus, refoc, refoc, on);
      soff = sim_megapress(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, sys, taus, refoc, refoc, off);
    end
    switch set.edit
      case 'diff'
        out = son;
        out.fids = son.fids - soff.fids;
        out.specs = son.specs - soff.specs;
      case 'off'
        out = soff;
    end
    out.te = set.te_ms;
    out.tr = 0;
    if ~isfield(out, 'txfrq'), out.txfrq = set.field_T * gamma * 1e6; end
    export_fida(out, fullfile(d, name));
    printf('%s %s\n', set.id, name);
    fflush(stdout);
  end
end

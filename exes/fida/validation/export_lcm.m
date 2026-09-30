function export_lcm(fida, data)
% EXPORT_LCM  Write LCModel files with FID-A's io_writelcm for the tests.
%   export_lcm(FIDA, DATA) takes the first FID of the GE PRESS example
%   (metabolite frames, and water frames) and the Philips water-suppressed
%   SDAT, marks them coil-combined and averaged, and writes
%   DATA/LCModel/<name>.RAW / .H2O with io_writelcm (te as given below).
%   The Rust tests write the same structures and compare the text byte for
%   byte; export_readers.m then reads the files back with io_readlcmraw.
  warning('off', 'all');
  addpath(genpath(fida));
  here = fileparts(mfilename('fullpath'));
  addpath(fullfile(here, 'octave-shims'));
  outdir = fullfile(data, 'LCModel');
  if ~exist(outdir, 'dir'), mkdir(outdir); end
  [o, w] = io_loadspec_GE(fullfile(data, 'GE/sample01_press/press/P17920.7'), 1);
  io_writelcm(first_fid(o), fullfile(outdir, 'ge_press.RAW'), 35);
  io_writelcm(first_fid(w), fullfile(outdir, 'ge_press.H2O'), 35);
  s = io_loadspec_sdat(fullfile(data, 'Philips/philips_spar_sdat_WS.SDAT'), 1);
  s.flags.averaged = 1;
  io_writelcm(s, fullfile(outdir, 'sdat_ws.RAW'), 30);
end

function s = first_fid(s)
  s.fids = s.fids(:, 1, 1);
  s.sz = size(s.fids);
  s.dims.coils = 0; s.dims.averages = 0; s.dims.subSpecs = 0;
  s.flags.addedrcvrs = 1;
  s.flags.averaged = 1;
end

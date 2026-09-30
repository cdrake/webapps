function outroot = fida_setup()
% FIDA_SETUP  Put the Octave-patched FID-A copy and the shims on the path.
%   outroot = fida_setup() returns $FIDA_TEST_DATA/ops, creating it.
%   FIDA_OCT (default $TMPDIR/fida/FID-A-oct) is the patched FID-A copy
%   described in README.md.
  warning('off', 'all');
  pkg load statistics;
  here = fileparts(mfilename('fullpath'));
  fida = getenv('FIDA_OCT');
  if isempty(fida)
    fida = fullfile(getenv('TMPDIR'), 'fida', 'FID-A-oct');
  end
  addpath(genpath(fida));
  % The shims go last on the path so they shadow FID-A and Octave:
  % contains, statset, nlinfit and the no-op plotting functions.
  addpath(fullfile(here, 'octave-shims'));
  addpath(fullfile(here, 'octave-shims', 'noplot'));
  addpath(here);
  data = getenv('FIDA_TEST_DATA');
  if isempty(data)
    error('Set FIDA_TEST_DATA to the directory that receives the reference exports.');
  end
  outroot = fullfile(data, 'ops');
  if ~exist(outroot, 'dir')
    mkdir(outroot);
  end
end

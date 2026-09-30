% REF_PIPELINES  FID-A reference for the Rust pipelines (tests/pipeline.rs).
%   FIDA_TEST_DATA=... octave-cli ref_pipelines.m
%   Loads the GE PRESS and Siemens SPECIAL examples with FID-A's own readers,
%   exports the loaded structures (the Rust tests' inputs) and every
%   intermediate of the deterministic pipelines to $FIDA_TEST_DATA/ops/.
%   FIDA_EXAMPLES defaults to /home/ubuntu/src/mrs/FID-A/exampleData.
root = fida_setup();
ex = getenv('FIDA_EXAMPLES');
if isempty(ex)
  ex = '/home/ubuntu/src/mrs/FID-A/exampleData';
end

% (a) GE PRESS with water frames. run_pressproc_GEauto conjugates both.
[raw, raww] = io_loadspec_GE(fullfile(ex, 'GE', 'sample01_press', 'press', 'P17920.7'), 1);
raw = op_complexConj(raw);
raww = op_complexConj(raww);
d = fullfile(root, 'ge_press');
mkdir(d);
export_fida(raw, fullfile(d, 'raw'));
export_fida(raww, fullfile(d, 'raww'));
tic;
pressproc_det(raw, raww, d);
printf('GE PRESS pipeline: %.1f s\n', toc);
clear raw raww;

% (b) Siemens SPECIAL with its water reference.
sp = fullfile(ex, 'Siemens', 'sample02_special');
raw = io_loadspec_twix(fullfile(sp, 'special', 'specialDLPFC.dat'));
raww = io_loadspec_twix(fullfile(sp, 'special_w', 'specialDLPFC_w.dat'));
d = fullfile(root, 'special');
mkdir(d);
export_fida(raw, fullfile(d, 'raw'));
export_fida(raww, fullfile(d, 'raww'));
tic;
specialproc_det(raw, raww, d);
printf('SPECIAL pipeline: %.1f s\n', toc);

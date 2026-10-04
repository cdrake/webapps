% REF_GEAUTO  FID-A reference for the GE phasing of run_pressproc_GEauto.
%   FIDA_TEST_DATA=... octave-cli ref_geauto.m   (writes ops/ge_press_geauto)
root = fida_setup();
ex = getenv('FIDA_EXAMPLES');
if isempty(ex)
  ex = '/home/ubuntu/src/mrs/FID-A/exampleData';
end
[raw, raww] = io_loadspec_GE(fullfile(ex, 'GE', 'sample01_press', 'press', 'P17920.7'), 1);
raw = op_complexConj(raw);
raww = op_complexConj(raww);
d = fullfile(root, 'ge_press_geauto');
mkdir(d);
pressproc_det(raw, raww, d, true);

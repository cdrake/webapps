% REF_MEGA  FID-A reference for the MEGA-PRESS pipeline (megapressproc_det).
%   FIDA_TEST_DATA=... octave-cli ref_mega.m   (writes ops/siemens_mega)
%   Also writes diff.RAW and water.H2O with io_writelcm for an LCModel check.
root = fida_setup();
ex = getenv('FIDA_EXAMPLES');
if isempty(ex)
  ex = '/home/ubuntu/src/mrs/FID-A/exampleData';
end
sp = fullfile(ex, 'Siemens', 'sample01_megapress');
raw = io_loadspec_twix(fullfile(sp, 'megapress', 'megapressDLPFC.dat'));
raww = io_loadspec_twix(fullfile(sp, 'megapress_w', 'megapressDLPFC_w.dat'));
raw.fids = double(raw.fids);
raw.specs = double(raw.specs);
raww.fids = double(raww.fids);
raww.specs = double(raww.specs);
d = fullfile(root, 'siemens_mega');
mkdir(d);
export_fida(raw, fullfile(d, 'raw'));
export_fida(raww, fullfile(d, 'raww'));
tic;
[diffSpec, sumSpec, sub1, sub2, outw] = megapressproc_det(raw, raww, d);
printf('MEGA-PRESS pipeline: %.1f s\n', toc);
io_writelcm(diffSpec, fullfile(d, 'diff.RAW'), diffSpec.te);
io_writelcm(sub2, fullfile(d, 'off.RAW'), sub2.te);
io_writelcm(outw, fullfile(d, 'water.H2O'), outw.te);

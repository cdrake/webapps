# Validation against FID-A

The Rust port is checked against FID-A itself running in GNU Octave.

* FID-A: https://github.com/CIC-methods/FID-A at 1eaa2075625745beb7632f608dc2947b73295309.
* Octave needs two local fixes to run FID-A's Siemens reader, applied to a copy of
  the checkout, never to FID-A: `read_twix_hdr.m` indexes the struct array that
  Octave's `regexp(..., 'names')` returns (FID-A assumes a cell array), and
  `version=='XA60'` comparisons become `strcmp(version,'XA60')` (the `==` form
  errors on the 2-character VB/VD/VE version strings). `octave-shims/` adds
  MATLAB's `contains`.
* `export_fida.m` writes a FID-A structure as `name.json` + `name.bin` for the tests.

---
"noddi": minor
"@neurodesk/dwi2trx": minor
"dwi2trx": patch
---

NODDI has a third tensor fit, niimath dtifit, in Advanced settings beside weighted least squares (the default) and ordinary least squares. It is FSL dtifit's default linear fit in the dtifit-enabled niimath build that DWI2TRX uses, and it runs in a Web Worker on the same volumes as the other fits: the b0 volumes and the shells up to b = 1200 s/mm². Its FA and MD are equal to DWI2TRX's fit of the same volumes with the same mask. niimath dtifit writes no AD or RD map, so AD is its first eigenvalue and RD is the mean of the second and third; where niimath sets MD to zero for a negative eigenvalue, AD and RD are zero too. The app gives niimath unit bvecs and runs it with `-xflip 0`, and the direction map gets the sign rule of the other fits, so FA, MD, AD, RD, S0 and the direction agree with the ordinary least squares fit on the same data. The maps keep their BIDS names, the provenance records `tensorFit: "niimath-dtifit"`, and the automation `tensorFit` parameter accepts `niimath-dtifit`. With NODDI selected, the NODDI fit runs after it.

`@neurodesk/dwi2trx/runner` exports `runNiimath`, the browser's niimath runner on one cached module of the vendored dtifit build. The DWI2TRX tensor worker now imports it from the package instead of an app copy. `fitTensor` takes an optional `xflip` (`'0'`, `'1'` or `'auto'`), which goes to dtifit as `-xflip`; without it the argv does not change.

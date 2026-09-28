Run `pnpm --filter seedseg build` then `pnpm --filter seedseg exec playwright test`.
The test starts the app locally and runs all four published SeedSeg ONNX models.
Runtime and model files remain generated assets outside source control.

The synthetic fixture represents a cropped T1 prostate with intensity variation,
a smooth bias field and three dark cylindrical fiducials. It checks transport,
completion, geometry, finite probability maps and downloaded file checksums.
It does not measure clinical sensitivity, specificity or marker localization
accuracy. SeedSeg has no public clinical reference case; those scientific checks
remain unverified. The fixture is not offered as an app example.

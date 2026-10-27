Run `pnpm --filter seedseg build` then `pnpm --filter seedseg exec playwright test`.
The tests start the app locally and run the published SeedSeg ONNX models: the default v2
network (network 1 of 5) and the four legacy v1 models. Runtime and model files remain
generated assets outside source control.

The synthetic fixture represents a cropped T1 prostate: a uniform body ellipse, a brighter
prostate ellipsoid and three dark cylindrical fiducials at known voxel coordinates. Besides
transport, completion, geometry, finite probability maps and downloaded file checksums, the
v1 test requires exactly three marker components, each centred within one voxel of a planted
fiducial and together covering at least 90 % of the planted voxels. An empty or displaced
marker mask fails. The planted geometry is the reference; no earlier app output is.

The fixture is 1 mm isotropic and not N4-corrected, off the v2 networks' training protocol
(0.6875 x 0.6875 x 2 mm). v2 network 1 marks one of the three planted fiducials and flags the
count, so the v2 test requires every reported marker to lie within one voxel of a planted
fiducial, the marker list and the rank-valued mask to agree, and the count flag to show.

That is a localisation check on a phantom, not clinical validation. The v1 models mark a wider
region than the planted void (Dice 0.26 against the planted voxels), and on this phantom the
consensus rests mainly on one of the four models; two stay silent. Clinical sensitivity and
specificity remain unverified: SeedSeg has no public clinical reference case. The fixture is
not offered as an app example.

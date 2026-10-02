# Output support and sampling

These functions port `PointDataset.mask`, `Volume.resample`, and
`inr.sample.sample_points` from NeSVoR commit
`730ddaa3711a2304386de34193ea4b957892fe7b`.

Call `buildSupportMask(points, resolutions)` after fitting. `points` is packed
scanner/world xyz in millimetres transformed by the final learned slice poses.
`resolutions` has one xyz triplet per slice, including its acquisition thickness.
Do not pass normalized model coordinates or a resolution triplet per observation.
The returned volume has x-fastest arrays, xyz dimensions and a voxel-to-world
4×4 affine. Its default voxel budget limits allocations explicitly.

The support construction bins points with ties-to-even rounding, pads by ten
times the largest acquisition resolution, convolves with the upstream integrated
Gaussian kernel and uses its strict occupancy threshold. The separable CPU
convolution can be replaced with the `convolve` callback for a GPU implementation.
It must preserve zero padding, axis order z/y/x and the unnormalized kernel.

`resampleSupportMask(volume, outputResolution, options)` uses occupied voxel
centres to select its extent and adds ten output voxels on each side. It samples
the original mask with zero-padded trilinear interpolation and uses strict `> 0`
support, as upstream does. An optional 3×3 `rotation` controls output orientation;
the output translation is recomputed from support, rather than copied from an
orientation reference.

`sampleMaskedVolume(volume, evaluate, options)` evaluates only occupied voxels.
`evaluate` receives packed world-mm coordinates and returns densities. Its adapter
must map world coordinates into the model's centered/scaled coordinates.
`psfResolution` is output resolution times output PSF factor; the default of zero
explicitly disables PSF integration. Positive resolution with `nSamples > 1`
uses isotropic Gaussian jitter and averages densities, not model logits.
`nSamples: 1` uses the centre exactly, matching upstream. Outside-mask output is
zero. `sampleWorldPoints` provides the same integration without a volume.

The checked-in 20 KB fixture comes from executing unchanged upstream method ASTs
with CPU PyTorch. Its generator substitutes only the Volume and RigidTransform
storage wrappers to avoid importing optional CUDA modules; numerical mask,
convolution, grid sampling and point sampling are upstream code. It records source
file SHA-256 hashes and PyTorch version. Regenerate with:

```sh
python packages/nesvor/src/output/generate-fixture.py /path/to/NeSVoR \
  > packages/nesvor/src/output/upstream-fixture.json
node --test packages/nesvor/src/output/output.test.js
```

The tests compare exact support indices and kernel coefficients, resampled values
within 3e-6, and PSF averages within 2e-5 using recorded normal draws. These are
operator-level checks, not a claim of end-to-end reconstruction parity. JavaScript
convolution accumulates in double precision before float32 storage; PyTorch CPU
convolution accumulation can differ around a threshold for other inputs. Browser
random draws are Gaussian but do not reproduce the PyTorch random generator.

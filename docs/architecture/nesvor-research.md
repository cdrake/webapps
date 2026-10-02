# NeSVoR container and algorithm research

Research date: 2026-09-21. This is source analysis, not a runtime validation report. No reconstruction was executed for this document.

## Container baseline

The Neurodesk recipe declares NeSVoR `0.5.0`, architecture `x86_64`, and base image `junshenxu/nesvor:v0.5.0`. It exposes the `nesvor` command without rebuilding the algorithm. The recipe says to provide a CUDA GPU and use `--nv` with Apptainer. Its test only invokes `nesvor --help` and checks for `reconstruct`; it does not establish numerical correctness or GPU compatibility. Sources: [recipe](https://github.com/neurodesk/neurocontainers/blob/cf8c628446f22df544edfbd317893ace72a60dbc/recipes/nesvor/build.yaml), [container test](https://github.com/neurodesk/neurocontainers/blob/main/recipes/nesvor/fulltest.yaml).

The upstream `v0.5.0` source resolves to commit `730ddaa3711a2304386de34193ea4b957892fe7b`. The container tag does not establish an immutable image digest, exact installed package versions, or correspondence between the image and that commit. Resolve and record those facts before producing a backend release. The tagged source has no Dockerfile; do not treat the current upstream Dockerfile as the recipe for the historical image. Sources: [tag tree](https://api.github.com/repos/daviddmc/NeSVoR/git/trees/v0.5.0?recursive=1), [current Dockerfile](https://github.com/daviddmc/NeSVoR/blob/master/Dockerfile).

Upstream installation documentation describes CUDA 11.7 images and recommends NVIDIA Container Toolkit. Its source prerequisites include an NVIDIA GPU, Python 3.8+, GCC/G++ 7.5+, CUDA 10.2+, and CMake 3.21+. These are upstream guidance, not verified requirements for every modern GPU or driver. A release must test its actual image and publish a supported hardware matrix. [Installation documentation](https://nesvor.readthedocs.io/en/latest/installation.html).

## Scientific workflow and supported inputs

NeSVoR reconstructs a three-dimensional isotropic volume from multiple stacks of motion-corrupted MRI slices. Registration estimates slice positions; reconstruction fits a neural representation to the individual case. The fitted representation can later be sampled at another voxel spacing. This distinction matters because reconstruction performs optimization for each uploaded examination. [Tagged reconstruction implementation](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/commands.py), [training implementation](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/inr/train.py).

The primary input is an ordered collection of NIfTI stacks, `.nii` or `.nii.gz`, with optional corresponding masks and physical slice thicknesses. A supplied thickness can apply to all stacks or there can be one value per stack. Without explicit thickness, the CLI uses slice gap. The web application should display that inferred value for confirmation because slice spacing and acquisition thickness can differ. Keep stack, mask, and thickness associations explicit. Other upstream inputs include motion-corrected slice directories and a volume mask. [Tagged argument definitions](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/parsers.py), [input loader](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/io.py).

The public workflow includes these commands. The first release need not expose every command.

| Command | Role |
| --- | --- |
| `reconstruct` | Preprocess, register, fit a case-specific neural representation, and sample a volume |
| `register` | Export motion-corrected slices |
| `svr` | Classical rigid slice-to-volume reconstruction |
| `sample-volume` | Resample a saved NeSVoR model |
| `sample-slices` | Simulate slices from a saved model for comparison |
| `segment-stack` | Produce fetal-brain masks |
| `correct-bias-field` | Apply N4 bias correction |
| `assess` | Score stack quality or motion |

Source: [upstream usage](https://github.com/daviddmc/NeSVoR/tree/v0.5.0#usage).

The reconstruction pipeline loads stacks, optionally segments fetal brain, optionally applies N4 correction and quality assessment, registers slices, trains, and saves outputs. Its CLI defaults include `svort` registration, 0.8 mm output resolution, and 6,000 training iterations. Registration options are `svort`, `svort-only`, `svort-stack`, `stack`, and `none`. In `svort` mode it compares SVoRT and stack registration using NCC. [Command implementation](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/commands.py), [argument definitions](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/parsers.py).

The parser explicitly limits SVoRT to fetal-brain data. The README nevertheless includes a neonatal example using SVoRT. Treat this as a documented inconsistency, not evidence of validated neonatal performance. A first clinical-facing workflow should identify its supported anatomy and avoid automatically applying fetal models to other anatomy. Deformable reconstruction is labeled experimental upstream. [Registration argument contract](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/parsers.py), [quick-start examples and deformable warning](https://github.com/daviddmc/NeSVoR/tree/v0.5.0#quick-start).

The default SVoRT version is `v2`. Segmentation, N4 correction and Otsu thresholding are off; the quality metric and filtering method are `none`. Scanner-space output is off, so the normal SVoRT result is in atlas space. Missing masks start as all-true masks and are intersected with intensity greater than zero. This does not isolate fetal brain or trigger automatic segmentation. A supplied mask must match its stack's shape, voxel resolution and affine. Sources: [parser](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/parsers.py), [stack loader](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/image/image.py#L637), [input pipeline](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/io.py), [thresholding](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/preprocessing/masking/thresholding.py).

The proposed first preset therefore requires a reviewed mask per stack and confirmed thickness, with SVoRT v2 and optional preprocessing disabled. This is a product restriction to validate, not a claim that upstream requires masks. Package the SVoRT v2 weight under its runtime cache name `SVoRT_v2.pt`; the download's source filename is `checkpoint_v2.pt`. [SVoRT model loading](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/svort/inference.py#L531).

Primary results are a NIfTI reconstruction and optional `.pt` representation, motion-corrected slices, simulated slices, JSON arguments/results, and logs. The saved model includes a state dictionary, mask, and argument namespace. Its loader uses `torch.load`; a network service should not accept arbitrary uploaded model checkpoints in its first release. Server-owned models can support later resampling without introducing general checkpoint upload. [Output writer and model loader](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/io.py).

## Browser feasibility

The native implementation uses PyTorch automatic differentiation and AdamW, multiresolution hash encodings, and mixed-precision optimization. It fits parameters, including transformations, while consuming the individual examination. A fixed pretrained ONNX inference export does not implement this process. That is an inference from the [training loop](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/inr/train.py) and [model code](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/inr/models.py).

The accelerated path uses `tinycudann` encodings and networks. The package also builds CUDA extensions named `nesvor.slice_acq_cuda` and `nesvor.transform_convert_cuda`. Shipping those binaries in WebAssembly does not make CUDA callable from WebGPU. A browser implementation would require different kernels, optimization infrastructure, and parity testing. [Model code](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/inr/models.py), [extension declarations](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/setup.py).

There is a useful qualification. The source has a PyTorch hash-grid fallback when `tinycudann` cannot load, and the CLI accepts negative device IDs for CPU execution and switches to single precision. This makes it inaccurate to describe the mathematical algorithm as fundamentally CUDA-only. It does not prove that the distributed container provides practical CPU execution, and it does not provide a browser implementation. Do not advertise CPU, Apple Metal, or browser reconstruction until each path passes an actual reconstruction and numerical comparison. [Fallback implementation](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/inr/models.py), [CPU handling](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/commands.py).

Scope after design review: preserve the pinned CUDA runtime behind the downloadable backend and implement browser-native reconstruction as a required part of the same port. Browser processing includes registration and per-case training, not only inspection and remote control. The [browser research](nesvor-browser-research.md) and [implementation design](nesvor-browser-design.md) define its numerical work and parity gates. Neither path is considered complete on source analysis alone.

## Models, licenses, and examples

NeSVoR source uses MIT licensing. The toolkit's source license does not automatically describe every bundled model or dependency. The source configuration references SVoRT v1/v2, MONAIfbs, two-dimensional IQA, and three-dimensional IQA downloads. Avoid installing unused optional pipelines merely because the container includes them. [Source license](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/LICENSE), [asset URLs](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/config.py).

| Asset | Verified source facts | Release implication |
| --- | --- | --- |
| SVoRT v2 | Zenodo record 7486938, `checkpoint_v2.pt`, approximately 297.7 MB, CC BY 4.0 | Pin file digest and include attribution |
| SVoRT v1 | Same record, `checkpoint.pt`, approximately 490.2 MB, CC BY 4.0 | Include only if the selected workflow requires it |
| MONAIfbs model | Zenodo record 4282679, `models.tar.gz`, 340,312,912 bytes, CC BY 4.0 | Pin archive and extracted model digests |
| MONAIfbs code | Apache 2.0; upstream explicitly says it is not intended for clinical use | Preserve notices and do not imply validated clinical deployment |

Sources: [SVoRT record](https://zenodo.org/records/7486938), [MONAIfbs record metadata](https://zenodo.org/api/records/4282679), [MONAIfbs repository](https://github.com/gift-surg/MONAIfbs).

Package required weights into an offline-installable bundle or offer a setup-time asset download with integrity checks. Processing should not discover a missing model by trying to reach Zenodo from inside a hospital job. Keep mirrored models, validation images, and outputs on the repository's Hugging Face dataset, with provenance, license, and checksums in source manifests.

This investigation did not identify a pinned, redistributable fetal multi-stack demonstration dataset in the inspected NeSVoR examples. Their commands use placeholder file names. The upstream tests include a Shepp-Logan phantom generator with separate BSD attribution. That can inform a deterministic reconstruction fixture, but a generic phantom does not validate fetal-brain segmentation or SVoRT. [Example commands](https://github.com/daviddmc/NeSVoR/tree/v0.5.0#quick-start), [phantom source](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/tests/phantom3d.py).

A suitable release needs both a fast synthetic fixture for transfer/geometry/reconstruction checks and an approved fetal multi-stack example that exercises the advertised default pipeline. A synthetic fixture can use known slice transforms with registration disabled; it must be labeled accordingly. Finding and pinning the fetal example remains release work, not a solved dependency.

## Evidence required before release

- Record immutable container digest, exact NeSVoR commit, installed dependency versions, CUDA runtime, and model checksums.
- Run the unmodified baseline and backend adapter on the same pinned inputs, seed, and parameters. Compare voxel geometry, affine, finite values, and output differences under an explicitly measured tolerance.
- Validate segmentation and registration on the fetal example. A phantom with registration disabled only covers the reconstruction and transport path.
- Check per-stack thickness and masks, oblique affines, mismatched geometry, missing data, and invalid numerical settings before GPU work begins.
- Measure runtime and memory on supported GPUs. Upstream paper timings are not a service guarantee for this image or the clinician's hardware.
- Prove cancellation releases the GPU and temporary inputs, and prove failed jobs do not publish incomplete volumes as successful results.
- Record stage progress from actual backend events. The upstream CLI logs stage changes and intermittent training metrics, so a precise overall percentage requires extra instrumentation or an explicitly labeled estimate.

The final progress point follows the actual [stage timer implementation](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/cli/commands.py) and [training logger](https://github.com/daviddmc/NeSVoR/blob/v0.5.0/nesvor/inr/train.py). These checks are proposed acceptance criteria; none are claimed as completed here.

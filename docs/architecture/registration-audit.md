# Implicit registration audit

Issue [#612](https://github.com/neurodesk/webapps/issues/612): several apps register images as a
step inside a pipeline whose purpose is something else, often with ANTs, the slowest engine in the
catalogue. This audit lists every such step on 27 October 2026 (`f808da816`), what pins its output,
and whether to swap the engine.

The dedicated registration apps (ANTs, Greedy, elastix, FireANTs, EdgeReg) are out of scope. No
other app imports `@neurodesk/edgereg`, `@neurodesk/elastix` or `@neurodesk/fireants`.

## Engines

Measured speeds as recorded in the repository. No document compares the engines on the same data.

| Engine | Where | Transforms | Speed on a 1 mm T1 |
| --- | --- | --- | --- |
| ANTs `antsRegistration` 2.6.2, single-thread WASM | `packages/registration` (SYNcro), `packages/hmc-registration` (HMC, BISON) | rigid, affine, SyN; GC, CC, Mattes | SyN 49 s on an M4 Pro (`apps/ants/README.md`); SYNcro 186 s in WASM against 125 s in the container; BISON affine + SyN 999 s |
| Greedy (`greedy-rs`), threaded WASM | `packages/greedy`, `exes/greedy` | affine (12 DOF or `-dof 6` natively), NMI SVF; SSD, NMI; fixed mask `-gm` | NMI affine 0.6 s on 14 threads, 3.8 s on one; NMI SV 4.7 s and 22.6 s (native, `exes/greedy/README.md`) |
| niimath `-allineate` (AFNI 3dAllineate port) | `packages/edgereg`, `@niivue/niimath` | affine, rigid (`-warp shr`); fast engine, `lpc`, Hellinger | 8–10 s, 0.3 GB (`packages/edgereg/README.md`) |

Greedy has no neighbourhood cross-correlation metric. Neither Greedy nor allineate is validated
against the ANTs schedules below.

## Inventory

| App | Step | Engine now | Transform | Pinned by | Verdict |
| --- | --- | --- | --- | --- | --- |
| BISON | T1 → ICBM 2009c affine (`packages/bison/src/register.js` `affineArguments`) | ANTs, GC | rigid + affine | MINC agreement gates, CLI/browser byte equality | Keep (WP1 measured) |
| BISON | T1_VP → template affine + SyN (`nonlinearArguments`) | ANTs, GC + CC r2 | affine + SyN to 2 mm | same; prior correlation r 0.85 | Keep: Greedy failed the gates (WP1) |
| BISON | FLAIR → T1 (`rigidArguments`) | ANTs, Mattes | rigid | same | Keep (WP1 measured) |
| SYNcro app | normalisation to MNI152 (`apps/syncro/src/worker.js`) | Greedy by default, ANTs SyN on request | affine + NMI SVF | ANTs path: container parity | Keep: Greedy is already the default |
| SYNcro app | pathological → primary (`worker.js`) | Greedy NMI affine | affine | none | Keep |
| SYNcro command line | normalisation (`packages/syncro/src/node.js`) | Greedy by default, ANTs SyN with `--normalization ants` | affine + NMI SVF | release check on both engines; ANTs path: container parity | Done (WP2) |
| HMC | each DWI volume → model prediction (`exes/dwi/hmc/src/registration.rs`) | ANTs, GC | two rigid stages | #451 native-float gate, reference transform hashes | Keep ANTs for NiFreeze parity (WP3 declined) |
| fastprep | T1 → MNI152NLin2009cAsym (`exes/fastprep/core/src/stages.rs`) | Greedy NMI affine + SVF with `-gm` | affine + SVF | parity with `fastprep.py` | Keep |
| fastprep | SynthSR SDC warp | Greedy NMI SVF | SVF | parity with `fastprep.py` | Keep |
| fastprep | BOLD → T1, reference alignment | niimath `-allineate` (`lpc`, `shr`) | affine, rigid | parity with `fastprep.py` | Keep |
| Deface | template + face mask → subject (`packages/deface/src/pipeline.js`) | niimath `-deface` (allineate fast or Hellinger) | affine | CLI/browser byte equality | Keep: already EdgeReg's engine |
| CALMaR | lesion T1 → MNI160 (`apps/calmar/web/js/inference-worker.js`) | PCA prealign + SynthMorph ONNX | rigid + deformable SVF | registration quality and parity fixtures | Keep: learned, no iterative engine |
| TopoFit | template surfaces → subject (`packages/topofit/src/pipeline.js`) | TReGA ONNX + least squares | affine | TReGA bit reproducibility | Keep: part of the pinned OpenRecon workflow |
| NeSVoR | slices and stacks (`packages/nesvor/src/registration`) | SVoRT ONNX + JS rigid NCC | rigid | registration comparison scripts | Keep: slice-to-volume, no general engine fits |
| DWI correct | volume → prediction (`exes/dwi/shoreline`) | own Rust rigid + eddy | rigid + eddy | FSL eddy comparisons | Keep: 30 s against 2345 s for the ANTs harness |

No registration was found in the other apps. SDC's `packages/sdc/src/field-fit.js` (sdcflows
SyN-SDC) and hmc-registration's SDC entry points have no app caller. SCT's
`registerByCenterOfMass` is exported but not called. BrowserQC runs niimath `--qc` with an MNI air
template; whether niimath aligns it internally is not established here.

## Outcome

Three apps ran ANTs implicitly: BISON, SYNcro's command line and HMC. Only SYNcro's command line
changed.

### WP1: BISON stays on ANTs

BISON's registrations stand in for MINC tools (`bestlinreg_s2`, `nlfit_s`), so the gates are the
native-MINC agreement thresholds in `packages/bison/test/pipeline-native.test.js`. The native
reference was rebuilt on its five subjects from Neurodesk's CVMFS MINC and ANTs containers; the ANTs
pipeline reproduced the documented numbers and passed all ten gates.

Greedy estimated all three registrations, with ANTs `--apply` resampling through them. Its linear
steps passed on their own and took a fraction of the time. Its nonlinear registration did not: the
fast 2 mm schedule failed every subject on CSF, the cerebellum and deep grey matter, and the best
variant (400x200x100 iterations, linear mask dilated by 4 voxels) still failed two subjects, with
CSF Dice 0.69 against a gate of 0.77 on sub-HML0774. Greedy has only NMI; BISON's own measurements
show that cross-correlation is what brings SyN close to `nlfit_s`. Swapping just the linear steps
would save about 165 s of an unloaded 1352 s run (the ANTs affine and rigid take 94 and 130 s; Greedy
about 30 s each), at the cost of a second engine in BISON and a lower linear mask Dice (0.971 on
sub-HML0541, against ANTs' 0.975 and a gate of 0.97). BISON keeps ANTs. [`packages/bison/docs/preprocessing.md#greedy`](../../packages/bison/docs/preprocessing.md#greedy)
has the table.

The single-threaded Greedy build (`@neurodesk/greedy/single`) gives the threaded browser build's
bytes. A future BISON engine with a cross-correlation metric could run threaded in the browser
and single-threaded on the command line without breaking their byte equality.

### WP2: SYNcro's command line follows the app

The command line now defaults to Greedy, as the app does, through `@neurodesk/greedy/single`; the
committed single-threaded build runs the same bytes on Linux, Windows and macOS.
`--normalization ants` keeps the ANTs SyN path and its container parity. The release check
(`validation/package-check.mjs`) normalises the pinned scan with both engines. Against the
SYNcro 0.1.1 container's ANTs result, the Greedy run's warped brain has Dice 0.990 and correlation
0.947; against the MNI152 template its Dice is 0.967 (ANTs 0.966) and correlation 0.783 (ANTs
0.815). Brain extraction stays SynthStrip, where the app defaults to MindGrab.

### WP3: HMC keeps ANTs

`docs/architecture/dwi-hmc-plan.md` keeps ANTs because NiFreeze's parity depends on its GC metric.
A Greedy option would carry no parity claim, add a control and a second argv path, and speed up a
step that takes about five minutes with four workers. It was not added.

### Not swapped

fastprep, Deface and SYNcro's app already use Greedy or allineate. CALMaR, TopoFit and NeSVoR use
learned registration that is part of the published method. DWI correct's own engine is already
two orders of magnitude faster than the ANTs harness it replaced.

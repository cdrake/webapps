# deface

Remove facial features from a brain MRI for anonymization, **entirely in your browser** — no upload, no server. Drag in a NIfTI image (or a folder of DICOM files), pick a method, click Apply, and save the defaced result.

Live demo: deploys as a GitHub Project Page at `https://<org>.github.io/deface/`.

## How it works

All processing runs in WebAssembly (and WebGPU or WebGL2 for MindGrab, when available) on your machine so your images are not shared with the cloud:

- **[niimath](https://github.com/rordenlab/niimath)** does the registration-based defacing. It fits a bundled MNI template ([3dAllineate](https://afni.nimh.nih.gov/)-style affine registration, RW Cox / AFNI) to your scan and zeros the voxels over the face. Four variants combine two knobs — the registration engine and an optional **robustfov** crop of the neck/inferior slices for a tighter face mask:
  - **allineate (fast)** — the fast registration engine (Hellinger mutual information with a robust fallback), the default, ~5 s
  - **allineate (fast, robustfov)** — the fast engine after a `-robustfov` crop
  - **allineate (Hellinger)** — the exhaustive Hellinger engine (`-cost hel`): a reference-quality fit, but single-threaded in WebAssembly it can take a few minutes on a full-head scan (native niimath is ~6× faster via OpenMP threads that WASM lacks)
  - **allineate (Hellinger, robustfov)** — the Hellinger engine after a `-robustfov` crop
- **[brainchop mindgrab](https://github.com/neuroneural/brainchop)** — an edge-based AI model for omnimodal brain extraction, run with the published [`@brainchop/mindgrab`](https://www.npmjs.com/package/@brainchop/mindgrab) package on a hardware GPU (WebGPU or WebGL2) or, without one, its threaded CPU module. It masks out everything but the brain, so it removes the face along with the skull and scalp. Variants combine two knobs — a tight skull-strip vs. an **8mm** tissue margin around the brain (niimath `-close 1 8 0`), and optional **robustfov** neck/inferior-slice cropping before MindGrab: **mindgrab**, **mindgrab robustfov**, **mindgrab 8mm border**, and **mindgrab robustfov + 8mm**.
- **[NiiVue](https://niivue.com/)** renders the image.
- **[dcm2niix](https://github.com/rordenlab/dcm2niix)** converts dropped DICOM folders to NIfTI.

The core operation is a single niimath chain, e.g.:

```
niimath input -gz 0 -robustfov -deface avg152T1 avg152T1mask defaced.nii
```

All niimath I/O is uncompressed (`-gz 0`) for speed; NiiVue re-gzips when you Save.

The pipeline lives in [`packages/deface`](../../packages/deface/README.md), which the app and the
`deface` command line share: both run the same niimath argv on the same WebAssembly build, and the
same MindGrab modules, so the command line writes the app's download byte for byte.

Until October 2026 MindGrab ran from an app-local copy of the model (tinygrad-generated WebGPU
shaders with `shader-f16`, NiiVue's conform worker and a min-max intensity normalisation). Its
`net_mindgrab.safetensors` weights are byte-identical to the weights compiled into
`@brainchop/mindgrab` 0.1.20260925 (all 27 tensors, the same 25-layer MeshNet); the app now runs
that package's own conform, normalisation, largest-component cleanup and reslice instead, as the
brain extraction app and the command line do.

## License

**BSD-2-Clause.** Defacing uses a frozen BSD-2 build of niimath: the fast affine `-deface` engine, no GPL `spm_coreg`/SPM code, so the whole app is BSD-2-Clause. These validated artifacts remain shared through [packages/runtime-support](../../packages/runtime-support/src/niimath/). The npm release `@niivue/niimath@1.4.20260909` now provides the BSD feature set; migrate Deface after recording parity against this snapshot.

## Develop

```bash
npm install      # or: bun install
npm run dev      # vite dev server (http://localhost:8091)
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build
```

Needs a browser with WebGL2 or WebGPU. Without WebGPU the viewer uses WebGL2 and MindGrab runs on WebGL2 or the CPU.

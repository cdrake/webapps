# Brain2Print (web)

Turns a brain scan into a 3D-printable mesh in the browser. Load a NIfTI or
DICOM image, segment it with MindGrab, build a mesh from the segmentation
with niimath, inspect it in NiiVue, and download STL or OBJ.

WebGPU is required — the NiiVue viewer has no fallback, and the app says so
at startup. MindGrab runs with `backend: 'auto'`, so segmentation can still fall back to
WebGL2 or the threaded CPU module.

## Controls

- **Input image** — NIfTI or DICOM (drag-drop supported), or the example T1
  fetched from Hugging Face at startup.
- **Segment** — runs a MindGrab model on the loaded image: `16chan18cls`
  (fast) or `mindmap` (17 regions), `mindsnap` (103 regions: Desikan-Killiany
  cortex plus subcortical),
  or the default mindmap partial volume estimate, whose grey plus white matter
  fraction niimath meshes at 0.5 for a sub-voxel surface.
- **Mesh** — niimath builds a mesh from the segmentation; **largest component
  only**, **fill bubbles**, **simplify %** and **smoothing** (Humphrey's
  Classes iterations) control the result. The app checks that the mesh is a
  closed, consistently wound manifold and, since
  niimath writes vertices in world millimetres, flips the winding when the
  signed volume is negative so normals face outward regardless of the input
  affine's handedness.
- **Format / Download** — STL or OBJ, saved via NiiVue.

## Develop

```sh
pnpm --filter brain2print dev
pnpm --filter brain2print test
pnpm --filter brain2print lint
pnpm --filter brain2print build
pnpm --filter brain2print test:e2e # needs a WebGPU-capable Chromium
```

`dev` and `build` first run `scripts/copy-brainchop.mjs`, which stages
MindGrab's WebGPU, WebGL2 and CPU assets into `public/brainchop/<version>/`
(gitignored, regenerated each run).

## Agent automation

The `create-mesh` operation accepts an `image` as NIfTI or DICOM and the existing model, simplification, smoothing, largest-component and bubble-fill settings. It runs the same segmentation and meshing handlers as the interface. Outputs are the segmentation or partial-volume image, STL and MZ3. Both mesh files serialize the exact displayed vertices and triangle winding after the existing manifold check and correction. The report records the selected model, actual backend, mesh settings, signed volume and correction decision. Cancellation terminates inference or disposes niimath. The registered image viewer exposes slice/3D tabs and discrete labels when applicable. Full model validation requires hardware WebGPU; pure geometry round-trip tests also run in Node.

# DWI vendor checks

The [design](dwi-microstructure-design.md#data) asks each DWI app to run on the files and sidecars of other scanner vendors. These checks have no numeric gate. Each section records the input facts and the result of each app. GE follows in [#420](https://github.com/neurodesk/webapps/issues/420).

PR [#596](https://github.com/neurodesk/webapps/pull/596) (open) adds `docs/quality/dwi-vendor-checks-2026-10.md`, a scripted check of the same Philips series and of GE ds006837. It runs the browser checks on a 64×64×10 slab. This section adds full-volume browser runs, dwicorrect with the reverse b0, dwi2trx and a b-vector check. Where both reports measure the same item, the results agree. Merge the two reports when both are on `main`.

Report snapshot: [ee2463de](https://github.com/gdevenyi/webapps/commit/ee2463de87c02eb28bef953c9e56beb6ab864e73), 24 October 2026. These checks predate the N4 command line added by [#595](https://github.com/neurodesk/webapps/pull/595); its Philips workflow was not tested in this run.

Method: the production build of each app in headless Chromium (Playwright 1.64.0), driven through its interface or its automation contract with the BIDS files as given. Command-line results cover the runs listed below. Host: Intel Core Ultra 200V with Arc 130V/140V (xe, Mesa 26.2.4 Vulkan). Times are wall times on that host, not benchmarks.

## Philips

Data: OpenNeuro [ds007522](https://openneuro.org/datasets/ds007522) v2.0.1 (CC0), `sub-HML0001/ses-01`: `dwi/sub-HML0001_ses-01_dwi` and `fmap/sub-HML0001_ses-01_dir-PA_epi`. Philips Ingenia Elition X, 3 T, software 5.7.1, dcm2niix v1.0.20220720 ([#419](https://github.com/neurodesk/webapps/issues/419)).

### Input facts

| Item | Value |
|---|---|
| Grid | 128×128×69×136, 1.8125×1.8125×2 mm, int16, LAS, qform = sform (code 1), 5.2° oblique in plane |
| Scaling | `scl_slope` 39.0752, `scl_inter` 0 (`UsePhilipsFloatNotDisplayScaling` 1, `PhilipsScaleSlope` 0.0255917) |
| Shells | 12×b0, 12×b500, 48×b1000, 64×b2000 |
| b0 encoding | one volume b=0; 11 volumes b=1 with unit, non-zero b-vectors (volumes 2–8 and 133–136) |
| `PhaseEncodingDirection` | DWI `j`; reverse b0 `j-` |
| `SliceEncodingDirection` | absent; `dim_info` gives slice = k |
| `TotalReadoutTime` | DWI 0.0332897 s; reverse b0 0.0332836 s |
| Reverse b0 | 8 volumes (b=0 and 7×b=1), `IntendedFor` the DWI |
| b-vector convention | FSL, image axes. MRtrix `dwigradcheck` (MindGrab mask) selects the table as given: no flip, no permutation, mean length 80.5 against 44.3 for the next option |

All apps treat the b=1 volumes as b0 (threshold 50 s/mm²). All apps apply `scl_slope`. In the MindGrab mask of the N4 run, the median of the first b0 in the output, divided by the scaled input, is 1.003–1.010 for degibbs, dwidenoise, n4 and dwicorrect.

### Results

| App | Browser | Command line |
|---|---|---|
| degibbs | Pass, 101 s. Slice axes 1 and 2: the default when `SliceEncodingDirection` is absent. The default agrees with `dim_info` (slice = k). | Pass, 285 s. Decompressed NIfTI identical to the browser output. |
| dwidenoise | Pass, 14 s. 12 b0 and 124 weighted volumes found. | Pass, 8 s on 6 threads. 12 b0 and 124 weighted volumes found. Decompressed NIfTI and sidecar identical to the browser output. |
| n4 | Pass, 34 s. Field fitted on the mean of 12 b0, MindGrab mask 206570 voxels, field 0.73–1.27 in the mask (1st–99th percentile). | Not tested in this run; added later by [#595](https://github.com/neurodesk/webapps/pull/595). |
| noddi | Pass, 351 s. 10 maps downloaded. The mask is the 11th download, which does not start in this driver (see Notes). Median FA 0.150, ICVF 0.479, ODI 0.451 in the mask. Midline corpus callosum V1: mean \|x\| 0.81. | Pass, 296 s on 6 threads. Mask 206569 voxels (CPU MindGrab) against 206570 (WebGPU). FA, MD and ODI differ in 7 voxels and ICVF in 6. All are voxels where the two masks disagree (7 voxels; browser mask from the N4 run, same WebGPU MindGrab, same count). FA is above 1 in 399 voxels (maximum 1.225): the WLS fit allows negative eigenvalues. |
| dwicorrect (extra) | Pass, 82 s. The reverse b0 and its sidecar are accepted. 8 outlier slices replaced. Field −92 to 64 Hz (1st–99th percentile) in the mask. b-vectors rotated by up to 1.07°. The field sign is correct: unwarping AP by +u and PA by −u raises their correlation in the mask from 0.643 to 0.694 (0.548 with the opposite sign). | No command line. |
| dwi2trx (extra) | Tensor fit passes, 21 s. Tracking fails: `Streamline tracking failed: Failed to execute 'mapAsync' on 'GPUBuffer': [Device] is lost.` | Tensor fit passes, 39 s. FA identical to the browser except 4 mask-edge voxels. No tracking in the command line. |

All outputs keep the input grid and affine. Gradient files are byte-identical to the input (dwicorrect writes rotated b-vectors). Output sidecars keep `PhaseEncodingDirection` and `TotalReadoutTime`.

### Defects

- dwi2trx tracking loses the WebGPU device: [#598](https://github.com/neurodesk/webapps/issues/598). The defect is not specific to Philips: the Siemens ds005134 sub-01 series fails in the same way, and the pinned example tracks. The kernel reports a timed-out GPU job.
- No Philips-specific defect was found. This check made no code change.

### Notes

- NiiVue logs `Voxels not aligned with world space: 5.18 degrees from plumb` for each oblique volume. This is not a defect.
- In this headless Chromium, the 11th scripted download from one page does not start. A driver that clicks Download on each row of the 11-row NODDI result list gets no 11th file; in reverse order the mask downloads and the FA does not. The dwi2trx example shows the same limit at its 11th artifact. The apps are correct; a test must download at most 10 files from one page.

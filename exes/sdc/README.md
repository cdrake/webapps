# sdc

Reverse phase-encoding susceptibility distortion correction for the [`sdc` app](../../apps/sdc) and its `sdc` command line.
The method was chosen in [the reverse-PE options document](../../docs/architecture/dwi-reverse-pe-options.md).

| Crate | Content |
| --- | --- |
| `core` (`sdc-core`) | `hysco`: a port of PyHySCO 0.0.4; the permutation and the conversion of the field to Hz |
| `cli` (`sdc`) | `sdc pyhysco <image1> <image2> <prefix>`: reads NIfTI and BIDS sidecars, writes the field in Hz |
| `wasm` (`sdc-wasm`) | the C ABI that [`packages/sdc`](../../packages/sdc) compiles to `src/sdc.wasm` |

The workspace is GPL-3.0-or-later, because PyHySCO is GPL-3.0 (`LICENSE`, `NOTICE`).

```bash
make build test lint
target/release/sdc pyhysco sub-01_dir-AP_epi.nii.gz sub-01_dir-PA_epi.nii.gz sub-01
```

## PyHySCO port

`core/src/hysco.rs` follows PyHySCO 0.0.4 (PyPI; the git commit `bff6655` only names the initialization `InitializeCF` instead of `InitializeOT`) with the defaults of its `pyhysco` command:

- the optimal-transport initialization, blurred with `(−Δ + 1)⁻¹` on a periodic grid;
- the objective: sum of squared differences of the two corrected images, α = 300 times the 3D Laplacian smoothness term, β = 10⁻⁴ times the intensity barrier;
- Gauss-Newton with an Armijo line search and Jacobi-preconditioned CG (10 iterations, tolerance 0.1), at most 50 iterations, with PyHySCO's stopping rules in its order.

The port keeps PyHySCO's quirks: the barrier gives 0 where |∂b| ≥ 1 (its `nan_to_num`), the line search keeps the positive descent value after it flips an ascent direction, PCG returns its last iterate, and the gradient uses PyHySCO's interpolation derivative also where the interpolation clamps.

The inputs must be in one space: image 2 aligned to image 1. A 4D input is averaged over its volumes without motion correction.

### Deliberate divergence

PyHySCO's `interp_parallel` and `init_OT` allocate float32 buffers (`torch.empty` without a dtype), so a float64 PyHySCO run rounds its initialization to float32.
The port computes in float64 throughout.

### Parity

On ds005134 sub-01 (116 × 116 × 68, 2 mm, PE j-; the prepared pair of the options document):

| Stage | Max difference from PyHySCO float64 |
| --- | --- |
| initialization, PyHySCO with float64 buffers | 1.4e-13 relative |
| initialization, PyHySCO as released | 1.6e-6 relative (its float32 buffers) |
| objective and gradient at the same start | 1.1e-14 relative, gradient identical |
| one Gauss-Newton step, and the full run from the same start | 1.9e-14 relative |
| full run, field | 5.9e-6 mm |

The field in Hz differs from the float32 PyHySCO run of the options document by a median of 5.0e-6 Hz in the brain (maximum 0.026 Hz).
The WebAssembly module gives the native field to 3.8e-6 Hz (the CLI writes float32).
One run takes 1.3 s natively on one thread and 1.7 s in Node.

To repeat it: run `validation/pyhysco_reference.py` with PyHySCO 0.0.4 and PyTorch, then `cargo run --release --example parity -- <its output directory>`.

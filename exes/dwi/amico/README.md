# dwi-amico

NODDI by AMICO (Daducci et al. 2015), ported from AMICO 1.5.4 (`dmri-amico`, BSD-3-Clause, [LICENSE-AMICO](LICENSE-AMICO)).
AMICO 1.5.4 is the last release under that licence. Later releases have a non-commercial licence; do not port code from them.
The [design document](../../../docs/architecture/dwi-microstructure-design.md) records why this source was chosen.

## What is ported

| AMICO 1.5.4 | Here |
| --- | --- |
| `synthesis.NODDIIntraCellular`, `NODDIExtraCellular`, `NODDIIsotropic`, `_scheme2noddi` | `Protocol`, `watson_sh_coeff`, `legendre_gaussian_integral` |
| `models.NODDI.generate`, `resample` (atom grid, norms, float32 storage) | `Dictionary::new` |
| `lut.rotate_kernel`, `resample_kernel` (lookup-table rotation) | `Dictionary::atoms` (exact rotation, see below) |
| `models.NODDI.fit` | `Dictionary::fit` |
| `core.Evaluation.load_data` normalisation, dipy `TensorModel` direction | `Dictionary::normalise`, `Dictionary::direction` |
| `scipy.optimize.nnls` 1.11.4 (Lawson-Hanson Fortran) | `nnls.rs`, statement by statement |
| `spams.lasso(mode=2, pos=True)` | `lasso.rs` |

AMICO keeps only the m = 0 spherical-harmonic coefficient of each atom when it rotates it.
By the addition theorem, the rotated atom is Σ_l c_l √((2l+1)/4π) P_l(g·n).
`Dictionary::atoms` evaluates this for the exact fibre direction.
It needs no 32761-direction table (about 2 GB for a 100-volume acquisition), and its atoms equal AMICO's at the table directions to 4e-7.

`src/tables.rs` holds the data that does not depend on the acquisition: the z components of AMICO's 500 high-resolution directions, the m = 0 rows of its SH fit matrix and the first table direction.
`tools/gen_tables.py` writes it from an AMICO 1.5.4 installation; do not edit it.

The NODDI fit's first NNLS has more atoms than measurements, so its solution is not unique.
Only the same pivot order gives AMICO's answer, so `nnls.rs` keeps the Fortran's statements and labels.
The LASSO is strictly convex, so `lasso.rs` uses any exact method: coordinate descent, then an exact solve on the support and an optimality check.

The b0 cutoff follows the shared gradient rule, `b < 50 s/mm²`. AMICO 1.5.4 includes
`b = 50` among its b0 volumes. This port treats it as diffusion weighted, so the
tensor fit, mask and NODDI normalisation use the same b0 volumes.

## Parity

`tests/oracle.rs` compares the port with AMICO 1.5.4 voxel by voxel.
`tools/oracle.py` writes its input from AMICO itself; set `AMICO_ORACLE` to that file:

```bash
python -I tools/oracle.py INPUT_DIR WORK_DIR OUT_DIR 300
AMICO_ORACLE=OUT_DIR/oracle.json cargo test --release -p dwi-amico --test oracle -- --nocapture
```

The oracle of the numbers below is pinned on Hugging Face (`noddi/validation/`, `../validation/oracle.manifest.json`).
`python3 ../validation/fetch_oracle.py DEST` downloads and checks it, and prints `AMICO_ORACLE`.
The `oracle` job in `dwi-native.yml` runs the test with `DWI_REQUIRE_ORACLE=1`, which makes a missing oracle a failure, not a skip.

On 300 voxels of ds001226 sub-CON01 (b = 0/700/1200/2800):

| Comparison | Median | p95 | Maximum |
| --- | --- | --- | --- |
| ICVF, OD and ISOVF, with AMICO's table direction | 2.0e-7 | 2.5e-6 | 4.3e-4 |
| ICVF, OD and ISOVF, with the exact direction | 1.4e-4 | 1.8e-3 | |
| Fibre direction against dipy (degrees) | 1.5e-5 | | 2.1e-4 (p99) |

The remaining difference with the exact direction comes from AMICO's table, whose directions are about 1° apart.

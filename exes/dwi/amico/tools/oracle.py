"""Dump AMICO 1.5.4 NODDI intermediates for sampled voxels, for tests/oracle.rs, and check that
the zonal (Legendre) form of its atoms equals its lookup-table atoms. Run with AMICO 1.5.4 and
its 32761-direction table (about 2 GB):

    python -I tools/oracle.py INPUT_DIR WORK_DIR OUT_DIR N_VOXELS

INPUT_DIR holds dwi.nii.gz, dwi.bval, dwi.bvec and b0_brain_mask.nii.gz."""

import json
import os
import shutil
import sys

import amico
import amico.lut
import numpy as np
from scipy.special import eval_legendre

inp, work, out, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
subject = os.path.join(work, "subject")
os.makedirs(subject, exist_ok=True)
for name in ("dwi.nii.gz", "dwi.bval", "dwi.bvec", "b0_brain_mask.nii.gz"):
    shutil.copy(os.path.join(inp, name), os.path.join(subject, name))
os.chdir(work)
amico.core.setup()
amico.util.fsl2scheme(
    f"{subject}/dwi.bval", f"{subject}/dwi.bvec", f"{subject}/dwi.scheme"
)
ae = amico.Evaluation(".", "subject")
ae.load_data(
    "dwi.nii.gz", "dwi.scheme", mask_filename="b0_brain_mask.nii.gz", b0_thr=50
)
ae.set_model("NODDI")
ae.generate_kernels(regenerate=False)
ae.load_kernels()
model = ae.model
K = ae.KERNELS
scheme = ae.scheme
dirs32761 = amico.lut.load_directions(32761)

# zonal coefficients per shell and atom, recomputed as rotate_kernel does
from amico.synthesis import NODDIExtraCellular, NODDIIntraCellular

hr = amico.lut.create_high_resolution_scheme(scheme)
ic, ec = NODDIIntraCellular(hr), NODDIExtraCellular(hr)
aux = amico.lut.load_precomputed_rotation_matrices(12, 32761)
m0 = [int((l * l + l + 2) / 2 - 1) for l in range(0, 13, 2)]
ls = np.arange(0, 13, 2)
zonal = []
for kappa in 1 / np.tan(model.IC_ODs * np.pi / 2):
    s_ic = ic.get_signal(model.dPar, kappa)
    for v in model.IC_VFs:
        sig = v * s_ic + (1 - v) * ec.get_signal(model.dPar, kappa, v)
        zonal.append(
            [
                np.dot(aux["fit"], sig[500 * s : 500 * (s + 1)])[m0]
                for s in range(len(scheme.shells))
            ]
        )
zonal = np.array(zonal)  # atoms x shells x 7

dwi = ae.niiDWI_img
mask = ae.niiMASK_img > 0
rng = np.random.default_rng(1)
coords = np.argwhere(mask)
coords = coords[rng.choice(len(coords), size=n, replace=False)]
from dipy.core.gradients import gradient_table
from dipy.reconst import dti

dtm = dti.TensorModel(gradient_table(scheme.b, scheme.raw[:, :3]))
params = model.set_solver()
records = []
worst = 0.0
for i, j, k in coords:
    y = dwi[i, j, k, :].astype(np.float64)
    y[y < 0] = 0
    d = dtm.fit(y).directions[0].reshape(-1, 3)
    lut_idx = amico.lut.dir_TO_lut_idx(d[0], ae.htable)
    res, _, x, A = model.fit(y, d, K, params, ae.htable)
    n_lut = dirs32761[lut_idx]
    # zonal reconstruction at the LUT direction
    Az = np.ones_like(A)
    for s, shell in enumerate(scheme.shells):
        g = scheme.raw[shell["idx"], :3]
        g = g / np.linalg.norm(g, axis=1, keepdims=True)
        c = g @ n_lut
        P = np.stack([eval_legendre(l, c) for l in ls], 1) * np.sqrt(
            (2 * ls + 1) / (4 * np.pi)
        )
        Az[np.ix_(shell["idx"], np.arange(zonal.shape[0]))] = P @ zonal[:, s, :].T
    Az[:, -1] = A[:, -1]
    worst = max(worst, float(np.abs(Az - A).max()))
    records.append(
        {
            "voxel": [int(i), int(j), int(k)],
            "y": y.tolist(),
            "dir": d[0].tolist(),
            "lutDir": n_lut.tolist(),
            "icvf": float(res[0]),
            "od": float(res[1]),
            "isovf": float(res[2]),
            "x": np.asarray(x).tolist(),
        }
    )
print("max |zonal atom - AMICO LUT atom|:", worst)
os.makedirs(out, exist_ok=True)
meta = {
    "bvals": scheme.b.tolist(),
    "bvecs": scheme.raw[:, :3].tolist(),
    "norms": K["norms"][0].tolist(),
    "iso": K["iso"].tolist(),
    "voxels": records,
}
with open(f"{out}/oracle.json", "w") as f:
    json.dump(meta, f)
print("wrote", len(records), "voxels")

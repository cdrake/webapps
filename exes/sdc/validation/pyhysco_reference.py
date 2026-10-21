"""PyHySCO 0.0.4 in float64 with checkpoints for the Rust port (examples/parity.rs).

Usage: pyhysco_reference.py <image1.nii.gz> <image2.nii.gz> <pe-dim 1|2> <out-dir>

Runs PyHySCO's `pyhysco` command defaults (alpha 300, beta 1e-4, Jacobi-PCG,
Gauss-Newton, 50 iterations) in float64 and writes raw little-endian float64
arrays to <out-dir>: the permuted, normalized images (i1, i2), the initial
field before and after the blur (b0_cf, b0), the objective and gradient at b0
(j0, dj0), the field after one Gauss-Newton step (b1), the final field and
corrected images (b, corr1, corr2) and the loss per iteration (log_loss).
meta.txt holds m and the permuted voxel sizes.

PyHySCO's interp_parallel and init_OT compute in float32 buffers even in a float64
run.
b0_cf64 and b064 repeat the initialization with float64 buffers, which is what
the port computes.
"""

import sys
from pathlib import Path

import EPI_MRI.InitializationMethods as Init
import nibabel as nb
import numpy as np
import torch
from EPI_MRI.EPIMRIDistortionCorrection import (
    DataObject,
    EPIMRIDistortionCorrection,
    JacobiCG,
    m_plus,
    myAvg1D,
    myDiff1D,
    myLaplacian3D,
)
from optimization.GaussNewton import GaussNewton


def interp64(x, y, xs, device="cpu"):
    i = torch.searchsorted(x[:, 1:].contiguous(), xs.contiguous())
    j = torch.arange(x.shape[0]).view(x.shape[0], 1).expand_as(i)
    t = (xs - x[j, i]) / (x[j, i + 1] - x[j, i])
    return (y[j, i] * (1 - t) + y[j, i + 1] * t).squeeze(dim=0)


im1, im2, dim, out = sys.argv[1:]
out = Path(out)
out.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(8)
data = DataObject(im1, im2, int(dim), device="cpu", dtype=torch.float64)
loss = EPIMRIDistortionCorrection(
    data,
    alpha=300,
    beta=1e-4,
    averaging_operator=myAvg1D,
    derivative_operator=myDiff1D,
    regularizer=myLaplacian3D,
    rho=0.0,
    PC=JacobiCG,
)


def save(name, tensor):
    np.ascontiguousarray(np.asarray(tensor), "<f8").tofile(out / f"{name}.f64")


save("i1", data.I1.data)
save("i2", data.I2.data)
shape = list(m_plus(data.m))
save("b0_cf", loss.initialization.init_OT(data).reshape(shape))
b0 = loss.initialize(blur_result=True)
save("b0", b0)
jc, dj = loss.eval(b0, do_derivative=True)
save("j0", [jc.item()])
save("dj0", dj)
save("b1", GaussNewton(loss, max_iter=1, path=str(out / "it1")).run_correction(b0))
opt = GaussNewton(loss, max_iter=50, verbose=True, path=str(out / "ref"))
save("b", opt.run_correction(b0))
save("corr1", loss.corr1)
save("corr2", loss.corr2)
save(
    "log_loss", [h["loss"] for h in opt.log.history if isinstance(h.get("loss"), float)]
)

# init_OT also allocates iChf with torch.empty and no dtype: the default dtype.
original = Init.interp_parallel
Init.interp_parallel = interp64
torch.set_default_dtype(torch.float64)
init = Init.InitializeOT()
cf = init.init_OT(data).reshape(shape)
save("b0_cf64", cf)
save("b064", init.blur(cf, data.omega, data.m))
Init.interp_parallel = original
torch.set_default_dtype(torch.float32)

affine = nb.load(im1).affine
voxel = np.sqrt((affine[:3, :3] ** 2).sum(0))
perm = [2, 1, 0] if int(dim) == 1 else [2, 0, 1]
fields = [int(v) for v in data.m] + [repr(float(voxel[a])) for a in perm]
(out / "meta.txt").write_text(" ".join(str(v) for v in fields) + "\n")

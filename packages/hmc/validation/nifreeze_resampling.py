"""Compare this package's resampling with NiFreeze's on the synthetic series.

NiFreeze 3bcfb00 (``nifreeze/data/base.py``, ``to_nifti``) resamples each volume with
``nitransforms.resampling.apply(xform, frame, order=3)``: a SciPy cubic spline
(``map_coordinates``, prefiltered, constant 0 outside). Its transform is
``Affine(ITKLinearTransform.from_filename(mat).to_ras(reference, moving))``
(``nifreeze/registration/ants.py``). This package resamples with ANTs ``--apply`` and
``BSpline`` (order 3). The script applies NiFreeze's steps to the same ``.mat`` files and
input volumes, in float, and reports the difference relative to the peak of each volume,
over the whole grid and over the voxels at least 3 voxels from every face.

    node packages/hmc/validation/export-synthetic.mjs DIR
    python nifreeze_resampling.py DIR

Requires nitransforms 25.1.0, nibabel, NumPy and SciPy.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np
from nitransforms.io.itk import ITKLinearTransform
from nitransforms.linear import Affine
from nitransforms.resampling import apply


def main(directory: Path) -> None:
    source = nb.load(directory / "sub-01_dwi.nii")
    data = np.asanyarray(source.dataobj, dtype=np.float32)
    ours = np.asanyarray(nb.load(directory / "sub-01_desc-hmc_dwi.nii.gz").dataobj)
    bvals = np.loadtxt(directory / "sub-01_dwi.bval")
    rows = []
    for v in range(data.shape[3]):
        if bvals[v] <= 50:
            continue
        frame = nb.Nifti1Image(data[..., v], source.affine)
        mat = directory / f"sub-01_vol-{v:04d}_desc-hmc_xfm.mat"
        xform = Affine(
            ITKLinearTransform.from_filename(mat).to_ras(reference=frame, moving=frame),
            reference=frame,
        )
        theirs = np.asanyarray(apply(xform, frame, order=3).dataobj, dtype=np.float64)
        diff = np.abs(ours[..., v].astype(np.float64) - theirs)
        peak = float(np.abs(theirs).max())
        interior = diff[3:-3, 3:-3, 3:-3]
        rows.append(
            {
                "volume": v,
                "max_all": float(diff.max()) / peak,
                "max_interior": float(interior.max()) / peak,
                "mean_interior": float(interior.mean()) / peak,
            }
        )
    summary = {
        "volumes": rows,
        "max_all": max(r["max_all"] for r in rows),
        "max_interior": max(r["max_interior"] for r in rows),
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]))

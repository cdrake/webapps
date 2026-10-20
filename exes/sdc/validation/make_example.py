"""Build the sdc app's example from OpenNeuro ds005134 1.0.0 sub-01 (CC0).

Usage: make_example.py <ds005134-dir> <out-dir>

Keeps axial slices 28-37 (10 of 69) of the b = 0 volumes: the 13 in the AP DWI
series (written with their bval and bvec) and the 8 of the PA field-map EPI.
The affines move the origin to the first kept slice. The sidecars keep only
the acquisition fields the app reads or reports.
"""

import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np

SLICES = slice(28, 38)
KEEP = [
    "PhaseEncodingDirection",
    "TotalReadoutTime",
    "EffectiveEchoSpacing",
    "EchoTime",
    "RepetitionTime",
    "MagneticFieldStrength",
    "Manufacturer",
    "ManufacturersModelName",
]

src, out = Path(sys.argv[1]) / "sub-01", Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)


def crop(path, volumes, name):
    img = nb.load(path)
    data = np.asarray(img.dataobj)[:, :, SLICES][..., volumes]
    affine = img.affine.copy()
    affine[:3, 3] = img.affine[:3, :3] @ [0, 0, SLICES.start] + img.affine[:3, 3]
    header = img.header.copy()
    header.set_data_dtype(img.get_data_dtype())
    nb.Nifti1Image(data, affine, header).to_filename(out / f"{name}.nii.gz")
    meta = json.loads(path.with_name(path.name.replace(".nii.gz", ".json")).read_text())
    side = {k: meta[k] for k in KEEP if k in meta}
    (out / f"{name}.json").write_text(json.dumps(side, indent=2) + "\n")
    return data.shape


dwi = src / "dwi" / "sub-01_dir-AP_run-001_dwi.nii.gz"
bval = np.loadtxt(dwi.with_name("sub-01_dir-AP_run-001_dwi.bval"))
bvec = np.loadtxt(dwi.with_name("sub-01_dir-AP_run-001_dwi.bvec"))
b0 = np.flatnonzero(bval <= 50)
print("AP", crop(dwi, b0, "sub-01_dir-AP_dwi"))
np.savetxt(out / "sub-01_dir-AP_dwi.bval", bval[None, b0], fmt="%g")
np.savetxt(out / "sub-01_dir-AP_dwi.bvec", bvec[:, b0], fmt="%g")
epi = src / "fmap" / "sub-01_dir-PA_run-001_epi.nii.gz"
print("PA", crop(epi, slice(None), "sub-01_dir-PA_epi"))

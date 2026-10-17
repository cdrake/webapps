"""Reference values for test/seals.test.js, from nnU-Net v1's own functions
(SEALS' copy in ISLES22_Ensemble/src/SEALS) and SciPy.

  python3 validation/seals-reference.py <ISLES22_Ensemble/src/SEALS>

Volumes are x-fastest: flat.reshape((X, Y, Z), order="F").
"""
import json
import sys

import numpy as np
from scipy.ndimage import binary_fill_holes

sys.path.insert(0, sys.argv[1])
from nnunet.network_architecture.neural_network import SegmentationNetwork
from nnunet.preprocessing.cropping import create_nonzero_mask, get_bbox_from_mask

out = {}
out["steps"] = {str(n): SegmentationNetwork._compute_steps_for_sliding_window((128,), (n,), 0.5)[0] for n in (100, 128, 129, 150, 160, 192, 200, 201, 203, 224, 256)}
g = SegmentationNetwork._get_gaussian((128, 128, 128), 1.0 / 8)
out["gaussian"] = {f"{x},{y},{z}": float(g[x, y, z]) for x, y, z in [(0, 0, 0), (64, 64, 64), (10, 64, 100), (127, 0, 63), (32, 96, 64)]}

# A 7x6x5 mask with an enclosed hole, a hole open to the border, and a
# hole closed only diagonally (6-connectivity fills it).
mask = np.zeros((7, 6, 5), bool)
mask[1:6, 1:5, 1:4] = True
mask[3, 2, 2] = False          # enclosed
mask[0:4, 3, 2] = False        # tunnel to the x = 0 face
out["fill_mask"] = mask.ravel(order="F").astype(int).tolist()
out["fill_holes"] = binary_fill_holes(mask).ravel(order="F").astype(int).tolist()

# nnU-Net v1 crop_to_nonzero + nonCT normalisation with use_mask_for_norm.
rng = np.random.default_rng(7)
a = rng.uniform(1, 9, (8, 7, 6)).astype(np.float32)
b = rng.uniform(1, 3, (8, 7, 6)).astype(np.float32)
a[:2] = 0; b[:2] = 0
a[:, :1] = 0; b[:, :1] = 0
a[5, 3, 3] = 0; b[5, 3, 3] = 0   # enclosed zero: inside the mask after hole filling
data = np.stack([a, b])
nonzero = create_nonzero_mask(data)
bbox = get_bbox_from_mask(nonzero, 0)
crop = data[:, bbox[0][0]:bbox[0][1], bbox[1][0]:bbox[1][1], bbox[2][0]:bbox[2][1]].copy()
m = nonzero[bbox[0][0]:bbox[0][1], bbox[1][0]:bbox[1][1], bbox[2][0]:bbox[2][1]]
for c in range(2):
    mean, std = crop[c][m].mean(), crop[c][m].std()
    crop[c] = (crop[c] - mean) / (std + 1e-8)
    crop[c][~m] = 0
out["crop_input"] = [a.ravel(order="F").tolist(), b.ravel(order="F").tolist()]
out["crop_offset"] = [int(r[0]) for r in bbox]
out["crop_dims"] = list(crop.shape[1:])
out["crop_data"] = [crop[c].ravel(order="F").tolist() for c in range(2)]
print(json.dumps(out))

"""Compare browser wrapper arithmetic against pinned NeSVoR without learned weights."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import types
import numpy as np
import torch

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
package = types.ModuleType("nesvor")
package.CHECKPOINT_DIR = ""
package.MONAIFBS_URL = ""
sys.modules["nesvor"] = package
image = types.ModuleType("nesvor.image")
image.Stack = object
sys.modules["nesvor.image"] = image
spec = importlib.util.spec_from_file_location("nesvor.preprocessing.masking.brain_segmentation", args.source / "nesvor/preprocessing/masking/brain_segmentation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
torch.set_num_threads(2)
class FixedModel(torch.nn.Module):
    def forward(self, image):
        return torch.cat((-image * .3, image + .2), dim=1)

cases = []
for width, height, count, rx, ry in [(19, 13, 2, .9, 1.1), (11, 17, 3, .75, .83)]:
    values = np.sin(np.arange(width * height * count, dtype=np.float32) * .117).reshape(count, 1, height, width)
    values[1] *= .15
    img = torch.from_numpy(values)
    resized = torch.nn.functional.interpolate(img, size=(int(height * ry / .8), int(width * rx / .8)), mode="bilinear", align_corners=True)
    normalized = (resized - resized.mean()) / (resized.std() + 1e-8)
    for augmentation in [False, True]:
        mask = module._segment(img, rx, ry, FixedModel(), 1, augmentation, 1, .1)
        cases.append({"shape": [width, height, count], "resolution": [rx, ry], "data": values.flatten().tolist(),
                      "normalized": normalized.flatten().tolist(), "augmentation": augmentation, "mask": mask.flatten().to(torch.uint8).tolist()})
args.output.write_text(json.dumps(cases))

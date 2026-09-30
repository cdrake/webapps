"""Evaluate original NeSVoR MONAIfbs on the decoded fetal stack fixture."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import types
import numpy as np
import torch
import monai

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--checkpoint", type=Path, required=True)
parser.add_argument("--fixture", type=Path, required=True)
args = parser.parse_args()
assert monai.__version__ == "0.3.0"
torch.set_num_threads(4)
package = types.ModuleType("nesvor")
package.CHECKPOINT_DIR = str(args.checkpoint.parent)
package.MONAIFBS_URL = ""
sys.modules["nesvor"] = package
image = types.ModuleType("nesvor.image")
image.Stack = object
sys.modules["nesvor.image"] = image
spec = importlib.util.spec_from_file_location("nesvor.preprocessing.masking.brain_segmentation", args.source / "nesvor/preprocessing/masking/brain_segmentation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.get_monaifbs_checkpoint = lambda: str(args.checkpoint)
original_load = torch.load
torch.load = lambda *a, **kw: original_load(*a, **dict(kw, weights_only=False))
model = module.build_monaifbs_net(torch.device("cpu"))
fixture = json.loads(args.fixture.read_text())
width, height, count = fixture["shape"]
image = torch.tensor(fixture["data"], dtype=torch.float32).reshape(count, 1, height, width)
mask = module._segment(image, *fixture["resolution"][:2], model, 1, True, 1, .1)
mask = mask.flatten().numpy().astype(np.uint8) & np.asarray(fixture["mask"], dtype=np.uint8)
mask.tofile(args.fixture.parent / "stack-mask.u8")
print(json.dumps({"foreground": int(mask.sum()), "voxels": len(mask), "sourceSha256": fixture["sourceSha256"]}))

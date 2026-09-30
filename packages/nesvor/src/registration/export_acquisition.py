"""Run in pinned CUDA NeSVoR; write small operator fixtures to stdout."""

import json
import torch
from nesvor.slice_acquisition import slice_acquisition, slice_acquisition_adjoint
from nesvor.slice_acquisition.slice_acq import USE_TORCH


def main():
    if USE_TORCH or not torch.cuda.is_available():
        raise RuntimeError("The CUDA operator is required; the Torch fallback has different numerical semantics")
    cases = []
    for border, masked in [(False, False), (True, False), (False, True)]:
        transform = torch.tensor([[[1, 0, 0, 0.3], [0, 1, 0, 0.125], [0, 0, 1, -2 if border else 0.25]]], device="cuda", dtype=torch.float32)
        volume = torch.arange(125, device="cuda", dtype=torch.float32).sin().view(1, 1, 5, 5, 5)
        slices = torch.arange(9, device="cuda", dtype=torch.float32).cos().view(1, 1, 3, 3)
        psf = torch.tensor([0.6, 0.2, 0.2], device="cuda", dtype=torch.float32).view(3, 1, 1)
        mask = torch.ones_like(volume, dtype=torch.bool) if masked else None
        if masked:
            mask[..., 2, 2, 2] = False
        forward, weights = slice_acquisition(transform, volume, mask, None, psf, (3, 3), 1.0, True, False)
        adjoint = slice_acquisition_adjoint(transform, psf, slices, None, mask, (5, 5, 5), 1.0, False, False)
        equalized = slice_acquisition_adjoint(transform, psf, slices, None, mask, (5, 5, 5), 1.0, False, True)
        flat = lambda value: value.flatten().cpu().tolist() if value is not None else None
        cases.append({
            "name": f"border={border},masked={masked}",
            "transforms": flat(transform), "volume": flat(volume), "slices": flat(slices),
            "psf": flat(psf), "psfShape": [1, 1, 3], "volumeShape": [5, 5, 5],
            "sliceShape": [3, 3], "resolution": 1, "volumeMask": flat(mask),
            "forward": flat(forward), "weights": flat(weights),
            "adjoint": flat(adjoint), "equalized": flat(equalized),
        })
    print(json.dumps({"source_commit": "730ddaa3711a2304386de34193ea4b957892fe7b", "torch": torch.__version__, "cases": cases}))


if __name__ == "__main__":
    main()

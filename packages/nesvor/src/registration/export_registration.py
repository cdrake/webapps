"""Emit CPU upstream registration fixtures; write stdout outside the repository."""
import json
import torch
from nesvor.image import Volume
from nesvor.transform import RigidTransform
from nesvor.svr.registration import VolumeToVolumeRegistration
from nesvor.utils import get_PSF, gaussian_blur, resample, ncc_loss


def main():
    torch.set_num_threads(1)
    coordinates = torch.arange(16, dtype=torch.float64)
    z, y, x = torch.meshgrid(coordinates, coordinates, coordinates, indexing="ij")
    data = torch.exp(-((x - 7) ** 2 / 8 + (y - 6) ** 2 / 12 + (z - 8) ** 2 / 6)) + 0.5 * torch.exp(-((x - 11) ** 2 + (y - 10) ** 2 + (z - 6) ** 2) / 3)
    data = data.float()
    source = Volume(data, transformation=RigidTransform(torch.tensor([[0., 0., 0., 2., -1., 0.]])), resolution_x=1)
    target = Volume(data, resolution_x=1)
    transform, loss = VolumeToVolumeRegistration()(source, target, use_mask=True)
    psf = get_PSF(res_ratio=(1.25, 1.25, 3.75), device="cpu")
    blurred = gaussian_blur(data[None, None], [0.5, 1., 1.5], 4)
    sampled = resample(blurred, [1., 1., 1.], [2., 2., 2.])
    print(json.dumps({
        "source_commit": "730ddaa3711a2304386de34193ea4b957892fe7b",
        "transform": transform.matrix().flatten().tolist(),
        "loss": loss.item(),
        "psf": psf.flatten().tolist(),
        "psfShape": list(psf.shape)[::-1],
        "blurredResampled": sampled.flatten().tolist(),
    }))


if __name__ == "__main__":
    main()

"""Run the pinned upstream mask/blur/resample methods, without importing CUDA extensions.

Usage: python generate-fixture.py /path/to/NeSVoR > upstream-fixture.json
Requires CPU PyTorch. Only the Volume/RigidTransform storage wrappers are replaced;
PointDataset.mask, Gaussian convolution, meshgrid and Volume resampling execute
unchanged source AST. The fixture records source hashes so its oracle is auditable.
"""
import ast
import hashlib
import json
import pathlib
import sys
import torch
import torch.nn.functional as F
import collections.abc
from typing import Collection, Optional, Union

root = pathlib.Path(sys.argv[1])
paths = ["nesvor/inr/data.py", "nesvor/utils/misc.py", "nesvor/image/image.py", "nesvor/inr/sample.py", "nesvor/inr/models.py", "nesvor/utils/psf.py"]
sources = {p: (root / p).read_text() for p in paths}
namespace = dict(torch=torch, F=F, collections=collections, Collection=Collection,
                 Optional=Optional, Union=Union, DeviceType=object)


def execute(node):
    # Deferred annotations avoid importing unrelated optional imaging dependencies.
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), node], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), "upstream-oracle", "exec"), namespace)


for node in ast.parse(sources[paths[1]]).body:
    if isinstance(node, ast.FunctionDef) and node.name in ["meshgrid", "gaussian_blur", "gaussian_1d_kernel"]:
        execute(node)


class Transform:
    def __init__(self, values, trans_first=True):
        self.trans_first = trans_first
        if values.shape[-1] == 6:
            self.rotation = torch.eye(3)
            self.translation = values[0, 3:]
        else:
            self.rotation = values[0, :, :3]
            self.translation = values[0, :, 3]

    def matrix(self):
        return torch.cat([self.rotation, self.translation[:, None]], 1)[None]

    def inv(self):
        inverse = torch.inverse(self.rotation)
        # Inverse represented translation-last to avoid changing coordinates.
        matrix = torch.cat([inverse, (-self.translation)[:, None]], 1)[None]
        return Transform(matrix, False)


def transform_points(transform, xyz):
    if transform.trans_first:
        return (transform.rotation @ (xyz + transform.translation)[..., None])[..., 0]
    return (transform.rotation @ xyz[..., None])[..., 0] + transform.translation


class Volume:
    def __init__(self, image, mask, transformation, rx, ry, rz):
        self.image = image
        self.mask = mask
        self.transformation = transformation
        self.shape_xyz = torch.tensor(image.shape[::-1])
        self.resolution_xyz = torch.tensor([rx, ry, rz])

    @property
    def xyz_masked(self):
        xyz = (torch.flip(torch.nonzero(self.mask), (-1,)) - (self.shape_xyz - 1) / 2) * self.resolution_xyz
        return transform_points(self.transformation, xyz)


namespace.update(Volume=Volume, RigidTransform=Transform, transform_points=transform_points)
for node in ast.parse(sources[paths[2]]).body:
    if isinstance(node, ast.ClassDef) and node.name == "Volume":
        for method in node.body:
            if isinstance(method, ast.FunctionDef) and method.name in ["sample_points", "resample"]:
                execute(method)
                setattr(Volume, method.name, namespace[method.name])
for node in ast.parse(sources[paths[0]]).body:
    if isinstance(node, ast.ClassDef) and node.name == "PointDataset":
        method = next(m for m in node.body if isinstance(m, ast.FunctionDef) and m.name == "mask")
        method.decorator_list = []
        execute(method)

points = torch.tensor([[x + 5, y - 8, z + 2] for z in range(-3, 4) for y in range(-3, 4) for x in range(-3, 4)], dtype=torch.float32)
resolutions = torch.tensor([[1, 1, 3]] * 7, dtype=torch.float32)
dataset = type("Dataset", (), dict(xyz_transformed=points, resolution=resolutions, mask_threshold=1))()
volume = namespace["mask"](dataset)
resampled = volume.resample(0.8, None)
rotation = torch.tensor([[0., -1., 0., 100.], [1., 0., 0., 200.], [0., 0., 1., 300.]])[None]
rotated = volume.resample(1.0, Transform(rotation))

import math
namespace.update(GAUSSIAN_FWHM=1 / (2 * math.sqrt(2 * math.log(2))))
for node in ast.parse(sources[paths[5]]).body:
    if isinstance(node, ast.FunctionDef) and node.name == "resolution2sigma": execute(node)
for node in ast.parse(sources[paths[4]]).body:
    if isinstance(node, ast.ClassDef) and node.name == "INR":
        for method in node.body:
            if isinstance(method, ast.FunctionDef) and method.name == "sample_batch": execute(method)
for node in ast.parse(sources[paths[3]]).body:
    if isinstance(node, ast.FunctionDef) and node.name == "sample_points": execute(node)

class Polynomial:
    sample_batch = namespace["sample_batch"]
    def __call__(self, xyz): return xyz[..., 0] ** 2 + 2 * xyz[..., 1] ** 2 + 3 * xyz[..., 2] ** 2

noise = []
original_randn = torch.randn
def traced_randn(*args, **kwargs):
    value = original_randn(*args, **kwargs)
    noise.extend(value.flatten().tolist())
    return value

torch.manual_seed(5)
torch.randn = traced_randn
sample_xyz = torch.tensor([[1., 2., 3.], [4., 5., 6.], [-1., -2., -3.]])
sample_values = namespace["sample_points"](Polynomial(), sample_xyz, 0.8, 2, 4)
torch.randn = original_randn


def describe(volume):
    indices = torch.nonzero(volume.mask.flatten()).flatten()
    matrix = volume.transformation.matrix()[0]
    rotation = matrix[:, :3]
    minimum = -(volume.shape_xyz - 1) / 2 * volume.resolution_xyz
    origin = transform_points(volume.transformation, minimum)
    affine = torch.cat([rotation * volume.resolution_xyz, origin[:, None]], 1)
    return dict(dims=volume.shape_xyz.tolist(), affine=affine.tolist() + [[0, 0, 0, 1]], indices=indices.tolist(), values=volume.image.flatten()[indices].tolist())

print(json.dumps(dict(sourceCommit="730ddaa3711a2304386de34193ea4b957892fe7b", sourceHashes={p: hashlib.sha256(s.encode()).hexdigest() for p,s in sources.items()}, torchVersion=torch.__version__, points=points.flatten().tolist(), resolutions=resolutions.flatten().tolist(), kernel=namespace["gaussian_1d_kernel"](3, 3, torch.device("cpu")).tolist(), support=describe(volume), resampled=describe(resampled), rotated=describe(rotated), sampling=dict(xyz=sample_xyz.flatten().tolist(), normals=noise, values=sample_values.tolist(), resolution=0.8, nSamples=4)), separators=(",", ":")))

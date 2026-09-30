"""Execute upstream DeformNet and deform_reg with a disclosed CPU encoder shim.

NeSVoR 0.5.0's CPU HashEmbedder rejects DeformNet's interpolation keyword.
The shim adds the explicitly requested smoothstep interpolation; the actual
upstream network, normalization and autograd regularizer execute unchanged.
This validates smoothstep mathematics, not tiny-cuda-nn hash-layout parity.
"""
import argparse
import ast
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import typing
import torch
import torch.nn as nn
import logging
from math import log2

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--input', required=True)
parser.add_argument('--output', required=True)
options = parser.parse_args()
source = Path(options.source) / 'nesvor/inr'
spec = importlib.util.spec_from_file_location('hash_grid_torch', source / 'hash_grid_torch.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SmoothHashEmbedder(module.HashEmbedder):
    def __init__(self, interpolation, **kwargs):
        assert interpolation == 'Smoothstep'
        super().__init__(**kwargs)

    def trilinear_interp(self, x, voxel_min_vertex, voxel_embedds):
        fraction = x - voxel_min_vertex
        smooth = fraction.square() * (3 - 2 * fraction)
        return super().trilinear_interp(smooth, torch.zeros_like(smooth), voxel_embedds)

namespace = dict(torch=torch, nn=nn, Namespace=argparse.Namespace, log2=log2,
                 USE_TORCH=True, TYPE_CHECKING=False, logging=logging,
                 Tuple=typing.Tuple, build_encoding=lambda **kwargs: SmoothHashEmbedder(**kwargs))
tree = ast.parse((source / 'models.py').read_text())
names = {'build_network', 'compute_resolution_nlevel', 'DeformNet'}
selected = [node for node in tree.body if getattr(node, 'name', None) in names]
regularizer = next(node for node in tree.body if getattr(node, 'name', None) == 'NeSVoR')
regularizer = next(node for node in regularizer.body if getattr(node, 'name', None) == 'deform_reg')
selected.append(regularizer)
exec(compile(ast.Module(body=selected, type_ignores=[]), str(source / 'models.py'), 'exec'), namespace)
fixture = json.loads(Path(options.input).read_text())
c = fixture['config']
args = argparse.Namespace(coarsest_resolution_deform=c['coarsest'], finest_resolution_deform=c['finest'],
                          level_scale_deform=c['levelScale'], n_features_per_level_deform=c['features'],
                          log2_hashmap_size=c['log2Size'], n_features_deform=c['embeddingFeatures'],
                          width=c['width'], dtype=torch.float32)
model = namespace['DeformNet'](torch.tensor(fixture['boundingBox']), args, c['spatialScaling'])
embedding = nn.Embedding(fixture['slices'], c['embeddingFeatures'])
parameters = list(model.encoding.parameters()) + list(model.deform_net.parameters()) + [embedding.weight]
serialized = fixture['parameters']
level_length = 2 ** c['log2Size'] * c['features']
source_parameters = [serialized[0][i:i + level_length] for i in range(0, len(serialized[0]), level_length)] + serialized[1:]
with torch.no_grad():
    for p, values in zip(parameters, source_parameters):
        p.copy_(torch.tensor(values).reshape(p.shape))
x = torch.tensor(fixture['xyz']).reshape(-1, 3).requires_grad_()
slices = torch.tensor(fixture['sliceIndices'], dtype=torch.long)
e = embedding(slices)
y = model(x, e)
g = torch.tensor(fixture['xyzGradient']).reshape(-1, 3)
weights = torch.tensor(fixture['regularizationWeights'])
# Per-query calls retain upstream's detached-coordinate/embedding regularizer.
regularizers = [namespace['deform_reg'](SimpleNamespace(deform_net=model), y[i:i+1, None], x[i:i+1, None], e[i:i+1, None]) for i in range(len(x))]
loss = (y * g).sum() + (torch.stack(regularizers) * weights).sum()
loss.backward()
parameter_gradients = [p.grad.flatten().tolist() for p in parameters]
levels = len(model.encoding.embeddings)
parameter_gradients = [sum(parameter_gradients[:levels], [])] + parameter_gradients[levels:]
Path(options.output).write_text(json.dumps(dict(xyz=y.detach().flatten().tolist(), xyzGradient=x.grad.flatten().tolist(), regularization=[r.item() for r in regularizers], gradients=parameter_gradients, oracle='Upstream v0.5.0 DeformNet/deform_reg with disclosed smoothstep CPU encoder shim')))

"""Full upstream objective fixture with the disclosed smoothstep CPU encoder shim."""
import argparse
import json
import torch
import nesvor.inr.models as models
from nesvor.inr.hash_grid_torch import HashEmbedder
from nesvor.transform import RigidTransform

class SmoothHashEmbedder(HashEmbedder):
    def __init__(self, interpolation, **kwargs):
        assert interpolation == 'Smoothstep'
        super().__init__(**kwargs)

    def trilinear_interp(self, x, voxel_min_vertex, voxel_embedds):
        t = x - voxel_min_vertex
        return super().trilinear_interp(t.square() * (3 - 2 * t), torch.zeros_like(t), voxel_embedds)

original_encoding = models.build_encoding
models.build_encoding = lambda **config: SmoothHashEmbedder(**config) if 'interpolation' in config else original_encoding(**config)
torch.set_num_threads(1)
torch.manual_seed(43)
config = dict(features=2, log2Size=3, levelScale=1.3819, coarsest=60, finest=30,
              width=5, depth=2, latent=3, sliceFeatures=3, spatialScaling=30,
              delta=.2, weightImage=1, weightTransformation=.1, learningRate=.005,
              weightDeform=.1)
deformation_config = dict(features=2, log2Size=3, levelScale=1.3819, coarsest=32, finest=8,
                          width=5, embeddingFeatures=3, spatialScaling=30)
args = argparse.Namespace(device='cpu', dtype=torch.float32, coarsest_resolution=60,
    finest_resolution=30, level_scale=config['levelScale'], n_features_per_level=2,
    log2_hashmap_size=3, n_features_z=3, width=5, depth=2, img_reg_autodiff=False,
    n_features_slice=3, no_slice_scale=False, no_slice_variance=False,
    no_pixel_variance=False, no_transformation_optimization=False,
    deformable=True, n_levels_bias=0, delta=.2, n_samples=5, image_regularization='edge',
    coarsest_resolution_deform=32, finest_resolution_deform=8,
    level_scale_deform=1.3819, n_features_per_level_deform=2, n_features_deform=3)
poses = torch.tensor([[.1,-.05,.2,.01,-.1,.03],[-.2,.1,.03,-.1,.02,.1]])
bounds = torch.tensor([[-1.,-1.,-1.],[1.,1.,1.]])
resolution = torch.tensor([[1.,1.,3.],[1.,1.,3.]])/30
model = models.NeSVoR(RigidTransform(poses), resolution, 1., bounds, 30., args)
with torch.no_grad():
    model.axisangle.add_(torch.tensor([[.001,-.002,.003,.002,.003,-.004],[-.003,.001,.002,-.002,.003,.001]]))
    model.logit_coef.copy_(torch.tensor([.2,-.1]))
    # Nontrivial fields exercise coordinate and second-order parameter gradients.
    for p in model.deform_net.parameters():
        p.uniform_(-.35,.35)
    for p in model.inr.encoding.parameters():
        p.uniform_(-.3,.3)
    for p in model.inr.density_net.parameters():
        p.uniform_(.05,.35)
field_groups = [list(model.inr.encoding.embeddings.parameters()),
          *[[p] for p in model.inr.density_net.parameters()],
          *[[p] for p in model.sigma_net.parameters()],
          [model.slice_embedding.weight], [model.logit_coef], [model.log_var_slice], [model.axisangle]]
deformation_groups = [list(model.deform_net.encoding.parameters()),
                      *[[p] for p in model.deform_net.deform_net.parameters()],
                      [model.deform_embedding.weight]]
def collect(groups, attribute=None):
    return [torch.cat([(getattr(p, attribute) if attribute else p).detach().flatten() for p in group]).tolist() for group in groups]
parameters = collect(field_groups)
deformation_parameters = collect(deformation_groups)
xyz = torch.tensor([[.12,-.2,.05],[.22,-.2,.05],[.32,-.2,.05]])
targets = torch.tensor([.7,.9,1.1])
indices = torch.tensor([0,1,0])
torch.manual_seed(87)
draws = torch.randn(3,5,3)
offsets = draws * model.psf_sigma[indices][:,None]
torch.manual_seed(87)
losses = model(xyz,targets,indices)
total = losses['MSE'] + losses['logVar'] + losses['imageReg'] + .1*losses['transReg'] + .1*losses['deformReg']
total.backward()
gradients = collect(field_groups, 'grad')
deformation_gradients = collect(deformation_groups, 'grad')
optimizer = torch.optim.AdamW(model.parameters(),lr=.005,betas=(.9,.99),eps=1e-15)
optimizer.step()
result = dict(sourceCommit='730ddaa3711a2304386de34193ea4b957892fe7b', torch=torch.__version__,
    oracle='Actual upstream NeSVoR forward/backward with disclosed SmoothHashEmbedder CPU shim; CUDA parity not established',
    config=dict(config,boundingBox=bounds.tolist(),poses=poses.flatten().tolist(),mean=1),
    deformationConfig=dict(deformation_config,boundingBox=bounds.tolist(),slices=2),
    parameters=parameters,gradients=gradients,updated=collect(field_groups),
    deformationParameters=deformation_parameters,deformationGradients=deformation_gradients,
    deformationUpdated=collect(deformation_groups),
    batch=[dict(slice=int(indices[i]),xyz=xyz[i].tolist(),target=float(targets[i]),offsets=offsets[i].tolist()) for i in range(3)],
    losses={name:float(value.detach()) for name,value in losses.items()})
print(json.dumps(result,allow_nan=False))

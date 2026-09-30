"""Run pinned upstream NeSVoR CPU forward, backward and AdamW on fixed PSF draws."""
import argparse
import json
import torch
from nesvor.inr.models import NeSVoR
from nesvor.transform import RigidTransform


def main():
    torch.set_num_threads(1)
    torch.manual_seed(43)
    config = dict(features=2, log2Size=3, levelScale=1.3819, coarsest=60, finest=30,
                  width=5, depth=2, latent=3, sliceFeatures=3, spatialScaling=30,
                  delta=0.2, weightImage=1, weightTransformation=0.1, learningRate=0.005)
    args = argparse.Namespace(device='cpu', dtype=torch.float32, coarsest_resolution=60,
        finest_resolution=30, level_scale=config['levelScale'], n_features_per_level=2,
        log2_hashmap_size=3, n_features_z=3, width=5, depth=2, img_reg_autodiff=False,
        n_features_slice=3, no_slice_scale=False, no_slice_variance=False,
        no_pixel_variance=False, no_transformation_optimization=False,
        deformable=False, n_levels_bias=0, delta=0.2, n_samples=3, image_regularization='edge')
    poses = torch.tensor([[.1,-.05,.2,.01,-.1,.03],[-.2,.1,.03,-.1,.02,.1]])
    bounds = torch.tensor([[-1.,-1.,-1.],[1.,1.,1.]])
    resolution = torch.tensor([[1.,1.,3.],[1.,1.,3.]])/30
    model = NeSVoR(RigidTransform(poses), resolution, 1., bounds, 30., args)
    with torch.no_grad():
        model.axisangle.add_(torch.tensor([[.001,-.002,.003,.002,.003,-.004],[-.003,.001,.002,-.002,.003,.001]]))
        model.logit_coef.copy_(torch.tensor([.2,-.1]))
    groups = [list(model.inr.encoding.embeddings.parameters()),
              *[[p] for p in model.inr.density_net.parameters()],
              *[[p] for p in model.sigma_net.parameters()],
              [model.slice_embedding.weight], [model.logit_coef], [model.log_var_slice], [model.axisangle]]
    def collect(attribute=None):
        return [torch.cat([(getattr(p, attribute) if attribute else p).detach().flatten() for p in group]).tolist() for group in groups]
    parameters = collect()
    xyz = torch.tensor([[.12,-.2,.05],[.22,-.2,.05],[.32,-.2,.05]])
    targets = torch.tensor([.7,.9,1.1])
    indices = torch.tensor([0,1,0])
    torch.manual_seed(87)
    draws = torch.randn(3,3,3)
    offsets = draws * model.psf_sigma[indices][:,None]
    torch.manual_seed(87)
    losses = model(xyz,targets,indices)
    total = losses['MSE'] + losses['logVar'] + losses['imageReg'] + .1*losses['transReg']
    total.backward()
    gradients = collect('grad')
    optimizer = torch.optim.AdamW(model.parameters(),lr=.005,betas=(.9,.99),eps=1e-15)
    optimizer.step()
    result = dict(sourceCommit='730ddaa3711a2304386de34193ea4b957892fe7b', torch=torch.__version__,
        config=dict(config,boundingBox=bounds.tolist(),poses=poses.flatten().tolist(),mean=1),
        parameters=parameters,gradients=gradients,updated=collect(),
        batch=[dict(slice=int(indices[i]),xyz=xyz[i].tolist(),target=float(targets[i]),offsets=offsets[i].tolist()) for i in range(3)],
        losses={name:float(value.detach()) for name,value in losses.items()})
    print(json.dumps(result,allow_nan=False))

if __name__ == '__main__':
    main()

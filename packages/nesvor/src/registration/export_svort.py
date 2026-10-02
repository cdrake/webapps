"""Export the learned SVoRTv2 subgraphs inside the pinned NeSVoR environment.

The custom acquisition and SRR operators deliberately remain outside ONNX.
Run with a locally downloaded checkpoint and an output directory outside the repo.
"""

import argparse
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from nesvor.svort.models import SVoRTv2


class ExportBatchNorm(torch.nn.Module):
    def __init__(self, native):
        super().__init__()
        if native.track_running_stats:
            raise ValueError('SVoRT export expects batch statistics in inference')
        self.weight = native.weight
        self.bias = native.bias
        self.eps = native.eps

    def forward(self, value):
        mean = value.mean(dim=(0, 2, 3), keepdim=True)
        variance = ((value - mean) ** 2).mean(dim=(0, 2, 3), keepdim=True)
        return (value - mean) * torch.rsqrt(variance + self.eps) * self.weight[None, :, None, None] + self.bias[None, :, None, None]


def export_batch_norms(module):
    for name, child in list(module.named_children()):
        if isinstance(child, torch.nn.BatchNorm2d):
            setattr(module, name, ExportBatchNorm(child))
        else:
            export_batch_norms(child)


class LearnedStep(torch.nn.Module):
    def __init__(self, network):
        super().__init__()
        self.network = network

    def forward(self, theta, slices, positions, estimated):
        net = self.network
        pe = net.pos_emb(torch.cat((theta, positions), -1))
        estimated = estimated if net.img_encoder.model.conv1.in_channels == 4 else None
        features = net.img_encoder(net.pos_augment(slices, estimated))
        features, _ = net.encoder(features, pe, None)
        score = torch.softmax(net.fc_score(features), dim=0) * features.shape[0]
        return theta + net.fc(features), score.clamp(max=3.0)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    torch.set_num_threads(4)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--checkpoint-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if sha256(args.checkpoint) != args.checkpoint_sha256:
        raise ValueError("SVoRT checkpoint digest mismatch")
    args.output.mkdir(parents=True, exist_ok=True)
    model = SVoRTv2(n_iter=4).cpu().eval()
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu")["model"])
    torch.manual_seed(0)
    records = []
    for index, network in enumerate((model.svrnet1, model.svrnet2)):
        native = LearnedStep(network).eval()
        wrapper = LearnedStep(copy.deepcopy(network)).eval()
        export_batch_norms(wrapper)
        args_in = (
            torch.randn(7, 9),
            torch.rand(7, 1, 128, 128),
            torch.randn(7, 2),
            torch.rand(7, 1, 128, 128),
        )
        filename = args.output / f"svort-v2-step-{index}.onnx"
        names = ["theta", "slices", "positions", "estimated"]
        torch.onnx.export(
            wrapper,
            args_in,
            str(filename),
            input_names=names,
            output_names=["theta_out", "score"],
            dynamic_axes={name: {0: "slices_count"} for name in names + ["theta_out", "score"]},
            opset_version=17,
            dynamo=False,
        )
        session = ort.InferenceSession(str(filename), providers=["CPUExecutionProvider"])
        errors = []
        for count in (7, 11):
            inputs = tuple(torch.rand(count, *value.shape[1:]) for value in args_in)
            feed = {name: value.numpy() for name, value in zip(names, inputs)}
            feed = {entry.name: feed[entry.name] for entry in session.get_inputs()}
            with torch.no_grad():
                expected = [value.numpy() for value in native(*inputs)]
            actual = session.run(None, feed)
            for got, wanted in zip(actual, expected):
                np.testing.assert_allclose(got, wanted, atol=1e-4, rtol=1e-4)
                errors.append(float(np.max(np.abs(got - wanted))))
            np.savez(args.output / f"svort-v2-step-{index}-{count}-fixture.npz", **feed, theta_out=expected[0], score=expected[1])
        records.append({"file": filename.name, "sha256": sha256(filename), "max_absolute_error": max(errors), "bytes": filename.stat().st_size})
    manifest = {
        "schema": 1,
        "source_commit": "730ddaa3711a2304386de34193ea4b957892fe7b",
        "checkpoint_sha256": args.checkpoint_sha256,
        "torch": torch.__version__,
        "onnxruntime": ort.__version__,
        "models": records,
        "browser_validated": False,
    }
    (args.output / "svort-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()

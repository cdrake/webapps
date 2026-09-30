"""Export the pinned NeSVoR MONAIfbs network and independent CPU fixtures."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import numpy as np
import torch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    package = types.ModuleType("nesvor")
    package.CHECKPOINT_DIR = str(args.checkpoint.parent)
    package.MONAIFBS_URL = ""
    sys.modules["nesvor"] = package
    image = types.ModuleType("nesvor.image")
    image.Stack = object
    sys.modules["nesvor.image"] = image
    name = "nesvor.preprocessing.masking.brain_segmentation"
    spec = importlib.util.spec_from_file_location(name, args.source / "nesvor/preprocessing/masking/brain_segmentation.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.get_monaifbs_checkpoint = lambda: str(args.checkpoint)
    # PyTorch 2.6 changed weights_only; this trusted pinned research archive predates it.
    original_load = torch.load
    torch.load = lambda *a, **kw: original_load(*a, **dict(kw, weights_only=False))
    import monai
    if monai.__version__ != "0.3.0":
        raise RuntimeError("Use pinned MONAI 0.3.0 via prepare-monai.py; newer DynUNet architectures differ.")
    model = module.build_monaifbs_net(torch.device("cpu"))
    graph = args.output / "monaifbs.onnx"
    torch.manual_seed(471)
    sample = torch.randn(1, 1, 448, 512)
    with torch.no_grad():
        torch.onnx.export(model, (sample,), graph, input_names=["image"], output_names=["logits"],
                          dynamic_axes={"image": {0: "batch", 2: "height", 3: "width"}, "logits": {0: "batch", 2: "height", 3: "width"}},
                          opset_version=17, dynamo=False)
        expected = model(sample).numpy()
    import onnxruntime as ort
    session = ort.InferenceSession(str(graph), providers=["CPUExecutionProvider"])
    actual = session.run(None, {"image": sample.numpy()})[0]
    error = float(np.max(np.abs(expected - actual)))
    if not np.allclose(expected, actual, rtol=3e-4, atol=3e-4):
        raise RuntimeError(f"ONNX differs from upstream: {error}")
    sample.numpy().tofile(args.output / "input.f32")
    expected.tofile(args.output / "logits.f32")
    manifest = {"source_commit": "730ddaa3711a2304386de34193ea4b957892fe7b",
                "checkpoint_sha256": hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(),
                "file": graph.name, "bytes": graph.stat().st_size,
                "sha256": hashlib.sha256(graph.read_bytes()).hexdigest(),
                "monai_version": "0.3.0", "license": "CC-BY-4.0", "source": "https://zenodo.org/records/4282679",
                "verification": {"onnx_cpu_max_absolute_error": error}}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()

"""Build flames-fold0.onnx from the published FLAMeS checkpoint.

    python export_model.py <Dataset004_WML directory> flames-fold0.onnx

Needs torch, dynamic_network_architectures (installed with nnunetv2), onnx and onnxruntime.

Three steps, each checked against ONNX Runtime on a random patch:
1. Export fold 0 of the nnU-Net PlainConvUNet at the plans' patch size, without deep supervision.
2. Rewrite every ConvTranspose (kernel == stride, no padding) as a 1x1x1 Conv followed by
   depth-to-space. The two are the same arithmetic; ONNX Runtime's WebGPU backend runs 3D Conv
   but not 3D ConvTranspose.
3. Store the convolution weights as float16 with a Cast to float32 in the graph. The download
   halves; ONNX Runtime folds the casts when the session is created, so arithmetic stays float32.
"""
import hashlib, json, sys, tempfile
from pathlib import Path

import numpy as np, onnx, onnxruntime as ort, torch
from dynamic_network_architectures.architectures.unet import PlainConvUNet
from onnx import helper, numpy_helper, shape_inference, TensorProto

TRAINER = 'nnUNetTrainer_8000epochs__nnUNetPlans__3d_fullres'
CHECKPOINT_SHA256 = '4fc7db24e7c1541b59023df2a2f498a964eb629fe38f4eaec763297dd3fdf861'


def export(root, path):
    plans = json.loads((root / 'plans.json').read_text())['configurations']['3d_fullres']
    kwargs = dict(plans['architecture']['arch_kwargs'])
    kwargs.update(conv_op=torch.nn.Conv3d, norm_op=torch.nn.InstanceNorm3d, dropout_op=None, nonlin=torch.nn.LeakyReLU)
    net = PlainConvUNet(input_channels=1, num_classes=2, deep_supervision=False, **kwargs)
    checkpoint = root / 'fold_0' / 'checkpoint_final.pth'
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    assert digest == CHECKPOINT_SHA256, f'unexpected checkpoint {digest}'
    net.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=False)['network_weights'])
    net.eval()
    torch.onnx.export(net, torch.zeros(1, 1, *plans['patch_size']), path, input_names=['input'], output_names=['logits'], opset_version=17, dynamo=False)
    return plans['patch_size']


def attribute(node, name):
    return next(helper.get_attribute_value(a) for a in node.attribute if a.name == name)


def replace_transposed_convolutions(model):
    model = shape_inference.infer_shapes(model)
    graph = model.graph
    initializers = {i.name: i for i in graph.initializer}
    shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in graph.value_info}
    nodes = []
    for node in graph.node:
        if node.op_type != 'ConvTranspose':
            nodes.append(node)
            continue
        kernel = attribute(node, 'kernel_shape')
        assert kernel == attribute(node, 'strides') and not any(attribute(node, 'pads')) and attribute(node, 'group') == 1, node.name
        weight = numpy_helper.to_array(initializers[node.input[1]])
        bias = numpy_helper.to_array(initializers[node.input[2]])
        inputs, outputs = weight.shape[:2]
        taps = int(np.prod(kernel))
        n, _, d, h, w = shapes[node.input[0]]
        name = node.name.strip('/').replace('/', '_')
        graph.initializer.extend([
            numpy_helper.from_array(weight.reshape(inputs, outputs * taps).T.reshape(outputs * taps, inputs, 1, 1, 1), name + '_weight'),
            numpy_helper.from_array(np.repeat(bias, taps), name + '_bias'),
            numpy_helper.from_array(np.array([n, outputs, *kernel, d, h, w], np.int64), name + '_split'),
            numpy_helper.from_array(np.array([n, outputs, d * kernel[0], h * kernel[1], w * kernel[2]], np.int64), name + '_merge'),
        ])
        nodes += [
            helper.make_node('Conv', [node.input[0], name + '_weight', name + '_bias'], [name + '_taps'], kernel_shape=[1, 1, 1], name=name + '_conv'),
            helper.make_node('Reshape', [name + '_taps', name + '_split'], [name + '_split_out'], name=name + '_split'),
            helper.make_node('Transpose', [name + '_split_out'], [name + '_shuffled'], perm=[0, 1, 5, 2, 6, 3, 7, 4], name=name + '_shuffle'),
            helper.make_node('Reshape', [name + '_shuffled', name + '_merge'], [node.output[0]], name=name + '_merge'),
        ]
        graph.initializer.remove(initializers[node.input[1]])
        graph.initializer.remove(initializers[node.input[2]])
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.value_info[:]
    return model


def store_half_precision(model):
    graph = model.graph
    casts = []
    for initializer in list(graph.initializer):
        value = numpy_helper.to_array(initializer)
        if value.dtype != np.float32 or value.size < 1024:
            continue
        half = numpy_helper.from_array(value.astype(np.float16), initializer.name + '_f16')
        graph.initializer.remove(initializer)
        graph.initializer.append(half)
        casts.append(helper.make_node('Cast', [half.name], [initializer.name], to=TensorProto.FLOAT, name=initializer.name + '_cast'))
    for cast in reversed(casts):
        graph.node.insert(0, cast)
    return model


def logits(path, patch):
    x = np.random.default_rng(0).standard_normal((1, 1, *patch)).astype(np.float32)
    return ort.InferenceSession(str(path)).run(None, {'input': x})[0]


def main():
    root = Path(sys.argv[1]) / TRAINER
    output = Path(sys.argv[2])
    with tempfile.TemporaryDirectory() as scratch:
        exported = Path(scratch) / 'fold0.onnx'
        patch = export(root, exported)
        reference = logits(exported, patch)
        rewritten = Path(scratch) / 'fold0-conv.onnx'
        onnx.save(replace_transposed_convolutions(onnx.load(exported)), rewritten)
        assert np.abs(logits(rewritten, patch) - reference).max() < 1e-3, 'ConvTranspose rewrite changed the output'
        model = store_half_precision(onnx.load(rewritten))
        onnx.checker.check_model(model)
        onnx.save(model, output)
    difference = np.abs(logits(output, patch) - reference)
    print(f'float16 weights: max logit change {difference.max():.4f}')
    print(f'{output}: {output.stat().st_size} bytes, sha256 {hashlib.sha256(output.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    main()

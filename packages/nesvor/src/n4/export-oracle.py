"""Run the pinned upstream function with SimpleITK; keep generated arrays outside git."""
import argparse
import ast
import json
from pathlib import Path
from typing import Optional, Dict, Any
import numpy as np
import SimpleITK as sitk

parser = argparse.ArgumentParser()
parser.add_argument('--upstream', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
source = args.upstream / 'nesvor/preprocessing/bias_field.py'
module = ast.parse(source.read_text())
function = next(node for node in module.body if isinstance(node, ast.FunctionDef)
                and node.name == 'n4_bias_field_correction_single')
namespace = dict(np=np, Optional=Optional, Dict=Dict, Any=Any)
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
correct = namespace[function.name]
sitk.ProcessObject.SetGlobalDefaultNumberOfThreads(1)
args.output.mkdir(parents=True, exist_ok=True)
cases = []
for shrink, unmasked in [(1, False), (2, False), (2, True)]:
    shape = [20, 18, 16]
    z, y, x = np.mgrid[:shape[2], :shape[1], :shape[0]]
    data = ((50 + 40 * (x > 9) + 15 * (y > 8)) * np.exp(0.025 * x + 0.012 * z)).astype(np.float32)
    mask = (((x - 10) / 9) ** 2 + ((y - 9) / 8) ** 2 + ((z - 8) / 7) ** 2 < 1).astype(np.uint8)
    if unmasked:
        mask.fill(1)
    settings = dict(shrink_factor_n4=shrink, n_iter_n4=3, n_levels_n4=2,
                    tol_n4=0.001, spline_order_n4=3, noise_n4=0.01,
                    n_control_points_n4=[4, 4, 4], n_bins_n4=200, fwhm_n4=0.15)
    resolution = [0.9, 1.3, 3.2]
    result = correct(data, mask, *resolution, settings).astype(np.float32)
    name = f'shrink-{shrink}' + ('-unmasked' if unmasked else '')
    for suffix, array in [('input', data), ('mask', mask), ('expected', result)]:
        array.tofile(args.output / f'{name}-{suffix}.bin')
    cases.append(dict(name=name, shape=shape, resolution=resolution,
                      unmasked=unmasked, options=dict(shrink=shrink, iterations=3, levels=2)))
(args.output / 'manifest.json').write_text(json.dumps(dict(simpleITK=sitk.Version_VersionString(), cases=cases), indent=2))

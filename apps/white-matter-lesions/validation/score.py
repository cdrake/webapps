"""Score binary lesion masks against expert labels.

    python score.py wmh <work> <method>...    # MICCAI 2017 WMH test subset (label 1 = WMH, 2 = other pathology, ignored)
    python score.py ms <work> <method>...     # MSLesSeg test split

Predictions are read from <work>/out/<method>/<case>.nii.gz (or <case>_seg.nii.gz, MindGlide's
name); a MindGlide prediction is its label 18. Lesions for recall and F1 are 26-connected.
Writes <work>/out/<method>.<dataset>.json and prints means per site.
"""
import glob, json, os, sys

import nibabel as nib, numpy as np
from scipy import ndimage


def score(pred, ref):
    ignore = ref == 2
    r = (ref == 1) & ~ignore
    p = (pred > 0) & ~ignore
    both = (r & p).sum()
    dice = 2 * both / (r.sum() + p.sum()) if r.sum() + p.sum() else 1.0
    avd = abs(p.sum() - r.sum()) / r.sum() * 100
    structure = np.ones((3, 3, 3))
    ref_labels, n_ref = ndimage.label(r, structure)
    pred_labels, n_pred = ndimage.label(p, structure)
    recall = len(np.unique(ref_labels[p & (ref_labels > 0)])) / n_ref if n_ref else 1.0
    precision = len(np.unique(pred_labels[r & (pred_labels > 0)])) / n_pred if n_pred else 1.0
    f1 = 2 * recall * precision / (recall + precision) if recall + precision else 0.0
    return dict(dice=dice, avd=avd, recall=recall, f1=f1, ref_voxels=int(r.sum()), pred_voxels=int(p.sum()))


def cases(dataset, work):
    if dataset == 'ms':
        for f in sorted(glob.glob(f'{work}/in_ms/*.nii.gz')):
            case = os.path.basename(f)[:-7]
            patient = case[3:]
            yield 'MSLesSeg', case, f'{work}/mslesseg/MSLesSeg Dataset/test/{patient}/{patient}_MASK.nii.gz'
        return
    for site, directory in json.load(open(f'{work}/subset.json')):
        yield site, f'{site}_{os.path.basename(directory)}', f'{work}/{directory}/wmh.nii.gz'


def main(dataset, work, method):
    rows = []
    for site, case, reference in cases(dataset, work):
        found = [f for f in (f'{work}/out/{method}/{case}.nii.gz', f'{work}/out/{method}/{case}_seg.nii.gz') if os.path.exists(f)]
        if not found:
            continue
        ref_image = nib.load(reference)
        pred_image = nib.load(found[0])
        assert pred_image.shape == ref_image.shape and np.allclose(pred_image.affine, ref_image.affine, atol=1e-3), found[0]
        pred = np.asarray(pred_image.dataobj)
        if method.endswith('mindglide'):
            pred = pred == 18
        rows.append(dict(case=case, site=site, **score(pred, np.rint(np.asarray(ref_image.dataobj)))))
    json.dump(rows, open(f'{work}/out/{method}.{dataset}.json', 'w'), indent=1, default=float)
    keys = ['dice', 'avd', 'recall', 'f1']
    print(f'{method}: n={len(rows)}', ' '.join(f'{k}={np.mean([r[k] for r in rows]):.3f}' for k in keys))
    for site in sorted({r['site'] for r in rows}):
        subset = [r for r in rows if r['site'] == site]
        print(f'  {site:18s}', ' '.join(f'{k}={np.mean([r[k] for r in subset]):.3f}' for k in keys))


if __name__ == '__main__':
    for name in sys.argv[3:]:
        main(sys.argv[1], sys.argv[2], name)

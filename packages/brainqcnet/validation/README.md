# BrainQCNet validation

The browser port is checked against the original BIDS app, the Docker image
`garciaml/brainqcnetcpu@sha256:d00acfddf4e6d8e594a0c6dff905080e4349250c173736c4248a5be9f697c969`
(torch 1.9.0, med2image 2.2.10, matplotlib 3.3.4, Pillow 10.3.0, nibabel 3.2.1),
with the authors' checkpoint `saved_models/resnet152/19112020/10push0.8167.pth`
from `saved_models.zip` (Google Drive, sha256 `aa2c7a9d…a666`).

## The original pipeline

`preprocess_and_predict.sh` runs, for each T1w file:

1. `crop_nii.py`: crop to the bounding box of voxels > 0.
2. `med2image --reslice`: every slice along x, y and z, `np.rot90`, saved by
   `pylab.imsave(cmap=Greys_r)`, which normalizes each slice to its own minimum
   and maximum.
3. `predict_all_axes.py`: each PNG to RGB, `Resize((224, 224))` (Pillow
   bilinear), `ToTensor`, ImageNet `Normalize`, then the ProtoPNet; a slice is
   flagged when the artifact logit is the larger.
4. `transform_log_to_csv.py`: `table.csv`, `tot_df.csv` and
   `{x,y,z}_results_locally.csv`.

`src/slices.js` and `src/summary.js` repeat each step's arithmetic: matplotlib's
float32 or float64 normalization (chosen by the NIfTI datatype and scaling as
nibabel returns it) and its `Greys_r` byte table, Pillow's 22-bit fixed-point
bilinear passes, torchvision's float32 normalization, Python's `round(x, 2)`
and pandas' CSV formatting.

## The model

`export_onnx.py` rebuilds `PPNet` from the upstream `model.py` and
`resnet_features.py` (copy them from BrainQCNet_CPU next to the script),
loads the checkpoint's `state_dict` (saved in the original image with torch
1.9) and exports the logits with opset 17. Global min pooling is written as a
`ReduceMin` so the batch axis stays dynamic; the minimum is the same value.

## Results

`run_reference.sh` runs steps 1–4 inside the image and keeps the slice PNGs;
with `DUMP=1`, `dump_slices.py` records each slice's resized image hash, logits
and prediction from the original torch model. `make-reference.mjs` packs a run
into `references/<id>.json`. Both examples are MR-ART sub-000103 (OpenNeuro
ds004173, CC0).

| Check | sub-000103 standard | sub-000103 headmotion2 |
| --- | --- | --- |
| Slices (x + y + z) | 682 | 679 |
| 224 × 224 slice images identical (`compare-slices.mjs`, unit test) | 682 / 682 | 679 / 679 |
| Slice predictions identical (`check-reference.mjs`, ONNX Runtime Node 1.29 CPU) | 682 / 682 | 679 / 679 |
| `table.csv`, `{x,y,z}_results_locally.csv`, `tot_df.csv` identical (except `t`) | yes | yes |
| Fraction of slices flagged, verdict | 0.31, no artifact | 0.67, artifact |
| Largest logit difference / largest logit | 11.4 / 2496 | 0.95 / 1558 |
| Smallest decision margin in the original | 0.40 | 0.061 |

`t` in `tot_df.csv` is the processing time, so it always differs.

The logits differ by up to 0.5 % of their range because each prototype
activation is `log((d + 1) / (d + 1e-4))` of a squared distance computed as
`x² + p² − 2xp`: where `d` is near zero, rounding differences between oneDNN
(torch) and other kernels are amplified. No slice of either example changes
class. A slice whose original margin is smaller than this drift could change
class on another runtime or backend, so the browser tests check the
predictions and files, not the logits.

Also checked:

- Datatypes. `make_variants.py` writes the example as unscaled int16, uint8,
  float32, int32 and float64; `png_only.sh` runs steps 1–2 on each in the image.
  `compare-slices.mjs` finds every PNG and resized slice identical (543 / 543
  each). The example itself is scaled int16, so it takes the float64 path.
- Methods and areas. `transform_log_to_csv.py` rerun on the headmotion2 log with
  `percentage`, `mean` and `median` and 2, 3, 5 and 7 areas: `compare-summary.mjs`
  finds every file identical.
- Resize. `pillow_fixture.py` resizes seven synthetic images in the image;
  `test/slices.test.js` holds the port to its hashes.
- ONNX. `validate_onnx.py` runs the export with ONNX Runtime (Python, CPU) on
  the PNGs the original wrote: 0 of 679 predictions differ, largest logit
  difference 0.95.

## Rerunning

```sh
# reference run for one file (about 6 minutes on 8 cores)
docker run --rm --user $(id -u):$(id -g) -e DUMP=1 --entrypoint sh \
  -v $PWD/in:/cand:ro -v $PWD/ref:/ref -v $PWD/validation:/harness:ro \
  -v $PWD/saved_models:/saved_models:ro garciaml/brainqcnetcpu@sha256:d00acfdd… \
  /harness/run_reference.sh /cand/sub-000103_acq-standard_T1w.nii.gz \
  /ref/sub-000103_acq-standard /saved_models/resnet152/19112020/ sub-000103
node validation/make-reference.mjs sub-000103-standard in/sub-000103_acq-standard_T1w.nii.gz ref/sub-000103_acq-standard
node validation/check-reference.mjs validation/references/sub-000103-standard.json in/sub-000103_acq-standard_T1w.nii.gz brainqcnet-resnet152-19112020.onnx
BRAINQCNET_EXAMPLE_DIR=in node --test test/*.test.js
```

`run_all.sh` loops `run_reference.sh` over a folder. Give each T1w file its own
run: the original `run.py` writes every T1w of a subject without a `run-`
entity to the same folder, so two acquisitions overwrite each other's slices.

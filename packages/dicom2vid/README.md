# @neurodesk/dicom2vid

Slice videos from DICOM series, NIfTI and MGZ volumes. The MRI2VID web app
(`apps/dicom2vid`) and the `dicom2vid` command line both run this code: the
same readers, series grouping, orientation, slice selection, windowing and
resampling, and the same video settings and muxers.

- `src/readers/`, `src/series.js`, `src/sources.js` read files into a volume
  and pick the series to encode.
- `src/pipeline.js` turns a volume into 8-bit frames (`renderFrame`).
- `src/video.js` holds the frame size, timing, key frame, bitrate and colour
  settings and creates the vendored MP4 and WebM muxers (`src/vendor/`).
- `src/raster.js` draws a frame and its slice label into a buffer and
  converts it to I420, which the command line encodes in place of a canvas.
- `src/encoder.js`, `src/inspect.js`, `src/libav.js`, `src/node.js` and
  `bin/dicom2vid.js` are the command line. They are Node-only and are not
  staged into the app.

The app stages the browser modules into `web/vendor/dicom2vid/` with
`scripts/stage-browser.mjs` (its `vendor` and `prebuild` scripts).

## Command line

The `dicom2vid` command runs on your own computer with Node.js. It needs no
browser, GPU, network or model files.

Download the release for your platform from the MRI2VID app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime. On Linux:

```bash
tar -xzf dicom2vid-VERSION-linux-x64.tar.gz
./dicom2vid-VERSION-linux-x64/dicom2vid self-check
./dicom2vid-VERSION-linux-x64/dicom2vid T1.nii.gz videos --orientation axial --fps 15
```

On Windows, use `Expand-Archive` and `dicom2vid.exe`. On macOS the installer
package installs the command in `/usr/local/bin`.

```text
dicom2vid INPUT... OUTPUT_DIR [options]
dicom2vid self-check
dicom2vid --help
```

`INPUT` is a NIfTI or MGZ/MGH file, or DICOM files or folders. Folders are
read recursively. When the input holds more than one series or volume, the
command lists them with their SeriesInstanceUID; choose one with
`--series-uid`. The options are the app's automation parameters:
`--orientation`, `--fps`, `--start`, `--end`, `--step`, `--annotate`,
`--format`, `--color-normalize`, `--upscale`, `--interpolation` and
`--mosaic-reduce`. The video is written into `OUTPUT_DIR`, which must be new
or empty, under the name the app downloads it as:
`<name>_<orientation>.webm` or `.mp4`.

### Differences from the web app

- Frames use the volume's full intensity range, as the app does until its
  histogram window is moved. Rotation and the stretch control are app-only.
- The encoder is libvpx VP9 instead of the browser's WebCodecs encoder, so
  the bytes differ while frame count, size, timing, key frames and quality
  match (see Validation). WebM is VP9, as Chromium writes it. MP4 is VP9 in
  MP4, the app's own fallback when a browser has no H.264 encoder; Chromium
  writes H.264 there. Use WebM, or the web app, for players without VP9.
- The slice label uses the public-domain font8x8 bitmap font, not the
  browser's sans-serif, at the same position and a similar size.

## Encoder

libvpx 1.16.0 and FFmpeg 9.0 compiled to WebAssembly by libav.js
(`@libav.js/variant-vp9-opus@6.10.9`, about 13 MB unpacked), run
single-threaded in the command line's own Node runtime. It encodes in real-time
mode without look-ahead, as Chromium does, with the app's bitrate and a key
frame every second. A static ffmpeg per platform would have added 30-80 MB per
archive and an executable to mirror and pin; H.264 encoders were not an option
(x264 is GPL, OpenH264 has no published WebAssembly build of libav.js).

## Validation

`validation/browser-reference.mjs` runs the production app in Playwright
Chromium on the app's pinned example and records each case in `cases.mjs`:
the WebM videos (`validation/browser-reference/`) and the container facts of
every video (`browser-reference.json`). `--check` fails when the app no longer
writes those bytes; rerun it without `--check` after changing the pipeline,
the video settings or Chromium, and commit the result.

`validation/cli-check.mjs --executable PATH` runs the command line on the same
cases and requires, per case, the browser's container, coded size, frame
count, timestamps and key frames, and on every decoded frame at least 30 dB
luma PSNR both against the browser's decoded frame and against the frames the
shared pipeline renders, no more than 3 dB below the browser's own. The
measured margins and the negative controls behind 30 dB are in the script.

## Licensing

BSD-3-Clause, as the app (`LICENSE`). Third-party components are listed in
`NOTICE`.

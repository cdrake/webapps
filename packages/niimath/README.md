# @neurodesk/niimath

A `niimath` command line that runs the NiiMath web app's WebAssembly build in
Node, so each output is the file the app downloads for the same image and
command.

## Why WebAssembly and not native niimath

niimath publishes native binaries, and native niimath (container
`vnmd/niimath`) is faster. This command line does not repackage them, for
three reasons:

- The web app runs `@niivue/niimath` 1.3.2. Native builds are compiled by a
  different compiler for each platform and round floating point differently.
  EdgeReg measured this on the same C code: native niimath changed 29 % of the
  voxels of a registration (`packages/edgereg/README.md`). A native archive
  could only be held to tolerances. This one reproduces the app byte for byte.
- `runNiimath` from `@neurodesk/node-drivers` already runs a caller-pinned
  niimath build under Node. The shared packager (`exes/node-cli`) builds,
  signs and verifies Node command lines as they are, as for EdgeReg, so the
  release needs no packager change and no mirrored third-party binaries.
- Each operation is single-threaded WebAssembly. On the examples, the
  slowest operation in the app's menu (`-fmedian`) takes about 10 s.

## Command line

```bash
niimath [-dt float|double] INPUT [OPERATION ...] OUTPUT [-odt TYPE]
niimath --help
niimath self-check
```

The arguments are native niimath's. Operations run left to right, as in the
app's command field:

```bash
niimath T1.nii.gz -s 2 smooth.nii.gz
niimath T1.nii.gz -mas brain_mask.nii.gz -otsu 5 tissue.nii.gz
niimath T1.nii.gz -mesh -i m -b brain.mz3
niimath T1.nii.gz -bitmap -o 0.5 -c inferno slice.png
```

- `OUTPUT` is a gzipped NIfTI image (`.nii.gz`), a mesh (`.mz3`, with `-mesh`)
  or a PNG bitmap (`.png`, with `-bitmap`), the three outputs the app offers.
  This build writes no other formats. Any other name is refused before
  anything runs.
- Output voxels are float, as in the app, unless `-odt` sets `char`, `short`,
  `int`, `float`, `double` or `input`.
- An operation argument that names an existing file, such as the mask above,
  is read from disk. Give it with its extension.
- Only `OUTPUT` is written. An existing `OUTPUT` is replaced, as native
  niimath does. `-save` is not supported.
- Standard output gets the written path. Standard error gets niimath's own
  messages, then one JSON line with the niimath build and the argv it ran.
- `--help` lists the operations of the pinned build, from the operator list
  `@niivue/niimath` ships. The WebAssembly build has no help text of its own.

The command line has no DICOM import. Convert DICOM with dcm2niix first, or
use the web app, which converts it in the browser. `self-check` runs
`-add 2 -mul 3` on a 64-voxel phantom and fails unless every voxel is exact.
`download-models` exists for the shared packager and does nothing.

### Install

Download the release for your platform from the NiiMath app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf niimath-VERSION-linux-x64.tar.gz
./niimath-VERSION-linux-x64/niimath self-check
```

On Windows, use `Expand-Archive` and `niimath.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs the command line in
`/usr/local/lib/neurodesk/niimath` and the `niimath` command in
`/usr/local/bin`. The installer replaces an existing `/usr/local/bin/niimath`,
such as a native binary copied there; Homebrew's `/opt/homebrew/bin` is not
touched:

```bash
sudo installer -pkg niimath-VERSION-macos-arm64.pkg -target /
niimath self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/niimath` and
`/usr/local/bin/niimath`, then run `sudo pkgutil --forget org.neurodesk.niimath`.

## Accuracy

`validation/cli-check.mjs` is the release gate. It runs the 14 commands the
app offers on both pinned examples in `apps/niimath/examples.json`: the
automation default (`-s 2`), the command field's default and the app's
example operations, including the mesh and the three bitmaps. Each output must
equal the web app's download byte for byte, and its decompressed bytes must
too. The command line has to write exactly the one file and print only its
path. Its provenance must name the niimath build the browser reference was
recorded with.

`validation/browser-reference.json` holds the web app's downloads.
`apps/niimath/e2e/reference.spec.js` recorded them through the built app, its
`process` automation and its niimath worker, in Chromium. The app hands niimath
the image NiiVue loaded rather than the file; on both examples that changes no
output byte. `test/reference.test.js` fails when the app offers a command the
reference does not cover.

```bash
node packages/niimath/validation/cli-check.mjs
node packages/niimath/validation/cli-check.mjs --executable path/to/niimath
NIIMATH_BROWSER_REFERENCE=write pnpm --filter niimath exec playwright test e2e/reference.spec.js
```

Rerecord the browser reference when the app's niimath pin or its commands
change. `apps/niimath/package.json` and this package pin the same exact
`@niivue/niimath` version, which `test/node.test.js` checks. The
`web-app-reference` job in `niimath-native.yml` reruns the browser recording
with `NIIMATH_BROWSER_REFERENCE=check`. On the validation host the release
check ran the 28 commands in 96 s; the web app took 157 s in headless Chromium.

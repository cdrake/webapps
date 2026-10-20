#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AXES, checkInstallation, removeRinging } from '../src/node.js';
import { DEFAULTS } from '../src/wasm.js';

const HELP = `Usage: degibbs IMAGE.nii[.gz] OUTPUT_DIR [options]
       degibbs self-check

Removes Gibbs ringing from every 2D slice of every volume by local subvoxel
shifts (Kellner et al. 2016), with the MRtrix3 3.0.8 mrdegibbs port the
Degibbs web app runs, and writes the app's downloads:

  <name>_desc-degibbs_<suffix>.nii.gz   the corrected image
  <name>_desc-degibbs_<suffix>.bval     the b-values, unchanged (when given)
  <name>_desc-degibbs_<suffix>.bvec     the b-vectors, unchanged (when given)
  <name>_desc-degibbs_<suffix>.json     the sidecar, with the step's Description

The .bval, .bvec and .json beside IMAGE with the same name are used unless
another file is given. OUTPUT_DIR must be new or empty.

Options:
  --bval FILE      b-values to pass through
  --bvec FILE      b-vectors to pass through
  --json FILE      BIDS sidecar; its SliceEncodingDirection sets the slice axes
  --axes A,B       the two in-plane axes: ${AXES.join(', ')} (default from the
                   sidecar, else 0,1)
  --nshifts N      subvoxel shifts per direction (default ${DEFAULTS.nshifts})
  --min-w N        lower edge of the window (default ${DEFAULTS.minW})
  --max-w N        upper edge of the window (default ${DEFAULTS.maxW})
  -h, --help       show this help

The output directory goes to standard output; progress and the run's
settings, as JSON, go to standard error. NIfTI input only: convert DICOM
with dcm2niix first, or use the web app. Cite Kellner E, Dhital B, Kiselev
VG, Reisert M. Gibbs-ringing artifact removal based on local subvoxel-shifts.
Magn Reson Med 2016;76:1574-1581, and MRtrix3 (Tournier et al. 2019).

degibbs has no model files. "download-models [--cache-dir DIR]" exists for
the portable packager and installs nothing.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'cache-dir': { type: 'string' },
      bval: { type: 'string' },
      bvec: { type: 'string' },
      json: { type: 'string' },
      axes: { type: 'string' },
      nshifts: { type: 'string' },
      'min-w': { type: 'string' },
      'max-w': { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log(`0 model files: degibbs has nothing to install in ${resolve(values['cache-dir'] ?? '.')}`);
  } else {
    if (positionals.length !== 2) throw new Error('Give a NIfTI image and a new output directory. Use --help for options.');
    const result = await removeRinging({
      input: positionals[0],
      output: positionals[1],
      bval: values.bval,
      bvec: values.bvec,
      json: values.json,
      axes: values.axes,
      nshifts: values.nshifts,
      minW: values['min-w'],
      maxW: values['max-w'],
      onProgress: (done, total) => process.stderr.write(`Volume ${done} of ${total}\n`),
    });
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

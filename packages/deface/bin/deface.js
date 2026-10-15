#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_METHOD, METHODS, checkInstallation, defaceImage, downloadModels } from '../src/node.js';

const HELP = `Usage: deface IMAGE.nii[.gz] OUTPUT_DIR [options]
       deface download-models [--cache-dir DIR]
       deface self-check

Removes the face from one head NIfTI image on the CPU, with the Deface web
app's methods, and writes defaced.nii, the file the web app downloads, in the
input's grid and datatype. The MindGrab methods also write brain-mask.nii,
the mask the image was multiplied by.

Options:
  --method NAME      ${DEFAULT_METHOD} (default): niimath registers the MNI template
                     and zeroes the voxels under its face mask (fast engine)
                     allineate_robustfov: crop the neck first
                     allineate_hel: exhaustive Hellinger registration, slower
                     allineate_hel_robustfov: neck crop and Hellinger
                     mindgrab: keep only the brain (MindGrab brain extraction)
                     mindgrab_robust: neck crop, then MindGrab
                     mindgrab8: MindGrab with an 8 mm border around the brain
                     mindgrab_robust8: neck crop, MindGrab and an 8 mm border
  --cache-dir DIR    Template directory (default NEURODESK_DEFACE_MODEL_DIR or
                     ~/.cache/neurodesk/deface/<template set>)
  --offline          Never download; fail if a template is missing
  -h, --help         Show this help

OUTPUT_DIR must be new or empty. The allineate methods need the MNI template
and face mask, which download once and are SHA-256 checked on every load.
MindGrab's weights are part of its WebAssembly module; it runs the web app's
CPU backend on all logical cores and needs about 2.6 GB of memory. Prints a
JSON report with the provenance. NIfTI input only: convert DICOM with dcm2niix
first, or use the Deface web app.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      method: { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  const allowOnly = (allowed) => {
    const ignored = Object.keys(values).find((name) => !allowed.includes(name));
    if (ignored) throw new Error(`${command} does not accept --${ignored}.`);
  };
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    allowOnly([]);
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    allowOnly(['cache-dir', 'offline']);
    const models = await downloadModels({
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    console.log(`${models.count} template files verified in ${models.directory}`);
  } else {
    if (positionals.length !== 2) throw new Error('Give one NIfTI image and a new output directory. Use --help for options.');
    const method = values.method ?? DEFAULT_METHOD;
    if (!Object.hasOwn(METHODS, method)) throw new Error(`--method must be one of ${Object.keys(METHODS).join(', ')}, not "${method}".`);
    const result = await defaceImage({
      input: positionals[0],
      output: positionals[1],
      method,
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

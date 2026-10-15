#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { QSMXT, checkInstallation, downloadModels, runQsmxt } from '../src/node.js';

const HELP = `Usage: qsmbly COMMAND [ARGS...]
       qsmbly download-models [--model ID ...] [--cache-dir DIR]
       qsmbly self-check

QSMbly's command line is QSMxT ${QSMXT.version} (qsm-core ${QSMXT.qsmCore}), the native
build of the pipeline the web app runs. For processing commands, replace
"qsmxt" with "qsmbly" in the command QSMbly exports, for example
  qsmbly run BIDS_DIR OUTPUT_DIR --qsm-algorithm rts
Run "qsmbly help" for the QSMxT commands.

Deep-learning weights are not included. Native compute first verifies all
19 weights (1.7 GB), downloading missing files from pinned URLs into
~/.cache/neurodesk/qsmbly/models. This also applies to classical runs:
native QSMxT has no offline switch, so a complete cache prevents its model
download fallback. "download-models" prepares the full offline cache;
--model fetches individual files. QSMBLY_OFFLINE=1 or NEURODESK_OFFLINE=1
forbids downloads and requires the full cache before native compute starts.
Native examples use a commit-pinned mirror and verified archives. Offline
mode disables example downloads; help and "example --list" remain available.
Native "slurm" and "tui" are unavailable because their scheduler jobs bypass
verified model preflight. Write scheduler jobs invoking "qsmbly run".
Prepare example data online, then use "run" offline.`;

const WRAPPER_COMMANDS = new Set(['download-models', 'self-check']);

const progress = (message) => process.stderr.write(`${message}\n`);

async function main(argv) {
  const [command] = argv;
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(HELP);
    return 0;
  }
  if (!WRAPPER_COMMANDS.has(command)) return runQsmxt(argv, { onProgress: progress });
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      model: { type: 'string', multiple: true },
      'cache-dir': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals.length) throw new Error(`${command} does not accept positional arguments.`);
  if (command === 'self-check') {
    if (values.model || values['cache-dir']) throw new Error('self-check does not accept options.');
    console.log(JSON.stringify(await checkInstallation()));
    return 0;
  }
  const models = await downloadModels({ models: values.model, cacheDir: values['cache-dir'], onProgress: progress });
  console.log(`${models.count} model files (${(models.bytes / 1e9).toFixed(2)} GB) verified in ${models.directory}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

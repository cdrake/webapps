#!/usr/bin/env node
import { checkInstallation, operationList, runCommandLine } from '../src/node.js';

const HELP = `Usage: niimath [-dt float|double] INPUT [OPERATION ...] OUTPUT [-odt TYPE]
       niimath self-check
       niimath download-models [--cache-dir DIR]

Runs a niimath (fslmaths-style) command line with the WebAssembly build the
NiiMath web app uses, so OUTPUT is the file the app would download for the
same image and command. Operations run left to right, as in the app's
command field:

  niimath T1.nii.gz -s 2 smooth.nii.gz
  niimath T1.nii.gz -mesh -i m -b brain.mz3
  niimath T1.nii.gz -bitmap -o 0.5 -c inferno slice.png

OUTPUT is a gzipped NIfTI image (.nii.gz), a mesh (.mz3, with -mesh) or a PNG
(.png, with -bitmap). Output voxels are float unless -odt sets char, short,
int, float, double or input. An operation argument that names an existing
file, such as -mas mask.nii.gz, is read from disk; give it with its
extension. Only OUTPUT is written; -save is not supported.

The written file goes to standard output. niimath's own messages and the
argv that produced the file, as JSON, go to standard error. download-models
does nothing: niimath uses no model files. Native niimath (container
vnmd/niimath) runs faster; its output differs from this build's by
floating-point rounding.

Operations:`;

const [command, ...rest] = process.argv.slice(2);
try {
  if (!command || command === '-h' || command === '--help') {
    console.log([HELP, ...await operationList()].join('\n'));
  } else if (command === 'self-check') {
    if (rest.length) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (rest.length && !(rest.length === 2 && rest[0] === '--cache-dir')) throw new Error('download-models accepts only --cache-dir DIR.');
    console.log('niimath needs no model files; nothing to download.');
  } else {
    const result = await runCommandLine([command, ...rest]);
    for (const line of result.log) process.stderr.write(`${line}\n`);
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

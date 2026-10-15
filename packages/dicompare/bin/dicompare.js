#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { analyze, buildSchema, checkInstallation, compare, downloadModels, listSchemas, serialize, writeReport } from '../src/node.js';

const HELP = `Usage: dicompare analyze DICOM... [--output FILE]
       dicompare compare DICOM... --schema SCHEMA [--schema-index N] [--output FILE]
       dicompare build-schema DICOM... [--name NAME] [--description TEXT]
                              [--version VERSION] [--author NAME]... [--output FILE]
       dicompare schemas
       dicompare download-models [--cache-dir DIR] [--offline]
       dicompare self-check

Runs the dicompare Python package in the same Pyodide build as the web app, offline.
DICOM arguments are files or directories, read recursively in sorted order.

  analyze       Group the DICOM instances into acquisitions and report their
                parameters (the app's acquisitions.json).
  compare       Validate every acquisition against one acquisition of a protocol
                schema (the app's comparison.json compliance report).
  build-schema  Export a protocol schema from the acquisitions, as the app's
                schema download does without edits.
  schemas       List the web app's schema library, usable as --schema NAME.

Options:
  --output, -o FILE    Write the JSON report to FILE instead of standard output
  --schema SCHEMA      Schema JSON file, or the name of a library schema
  --schema-index N     Zero-based acquisition in the schema (default 0)
  --name, --description, --version, --author
                       Schema metadata for build-schema (--author repeats)
  --cache-dir DIR      Python package directory (default NEURODESK_DICOMPARE_MODEL_DIR
                       or ~/.cache/neurodesk/dicompare/<package set>)
  --offline            Never download; verify the packages locally
  -h, --help           Show this help

Every Python package is SHA-256 checked before use; a run never uses the network.
A summary goes to standard error.`;

const COMMANDS = {
  analyze: ['output', 'cache-dir', 'offline'],
  compare: ['output', 'schema', 'schema-index', 'cache-dir', 'offline'],
  'build-schema': ['output', 'name', 'description', 'version', 'author', 'cache-dir', 'offline'],
  schemas: [],
  'download-models': ['cache-dir', 'offline'],
  'self-check': [],
};

function reportProgress() {
  let previous;
  return (message) => {
    if (!message || message === previous) return;
    previous = message;
    process.stderr.write(`${message}\n`);
  };
}

try {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    help: { type: 'boolean', short: 'h' }, output: { type: 'string', short: 'o' }, schema: { type: 'string' },
    'schema-index': { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
    version: { type: 'string' }, author: { type: 'string', multiple: true },
    'cache-dir': { type: 'string' }, offline: { type: 'boolean' },
  } });
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && token.name !== 'author') throw new Error(`Repeated option --${token.name}`);
    seen.add(token.name);
  }
  const [command, ...inputs] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    if (!values.help) process.exitCode = 1;
  } else {
    if (!(command in COMMANDS)) throw new Error(`Unknown command ${command}; use --help for commands`);
    const unexpected = [...seen].filter((name) => !COMMANDS[command].includes(name));
    if (unexpected.length) throw new Error(`${command} does not accept --${unexpected.join(', --')}`);
    const options = { cacheDir: values['cache-dir'], offline: values.offline, onProgress: reportProgress() };
    if (['schemas', 'download-models', 'self-check'].includes(command) && inputs.length) throw new Error(`${command} accepts no arguments`);
    if (command === 'self-check') {
      console.log(JSON.stringify(await checkInstallation()));
    } else if (command === 'schemas') {
      console.log((await listSchemas()).join('\n'));
    } else if (command === 'download-models') {
      console.log(JSON.stringify(await downloadModels(options)));
    } else {
      const run = { analyze, compare, 'build-schema': buildSchema }[command];
      const { report, summary, versions } = await run({ ...options, inputs, schema: values.schema,
        schemaIndex: values['schema-index'], name: values.name, description: values.description,
        version: values.version, authors: values.author });
      if (values.output) {
        const path = await writeReport(values.output, report);
        process.stderr.write(`Wrote ${path}\n`);
      } else {
        process.stdout.write(`${serialize(report)}\n`);
      }
      process.stderr.write(`${JSON.stringify({ ...summary, ...versions })}\n`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

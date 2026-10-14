#!/usr/bin/env node
import { parseArgs } from 'node:util';
import packageJson from '../package.json' with { type: 'json' };

process.env.ORT_DISABLE_TELEMETRY ??= '1';

const help = `Spinal Cord Toolbox web app segmentation, on the command line.

Usage:
  sct-webapp segment [--task TASK] input.nii[.gz] output-directory [options]
  sct-webapp download-models [--task TASK]... [--all] [--cache-dir PATH]
  sct-webapp tasks [--cache-dir PATH]
  sct-webapp self-check

Segment options:
  --task TASK                     spinalcord (default), graymatter, lesion_sci_t2, lesion_ms or spine
  --threshold 0.01..0.5           probability threshold (default: the model's)
  --minimum-component-size N      smallest kept component in voxels (default: the model's)
  --test-time-augmentation        average mirrored predictions (slower)
  --threads N                     CPU threads (default: up to 4)
  --cache-dir PATH                downloaded models (default: ~/.cache/neurodesk/sct-webapp)
  --offline                       never download; fail when a model is missing

Outputs are the web app's downloads: <task>_<stage>.nii for each mask and
<task>_lesion_metrics.csv for lesion tasks. A JSON report is printed on stdout.

The spinalcord model ships with the portable release. Download any other task's
model once with "sct-webapp download-models --task TASK". NEURODESK_OFFLINE=1,
which the portable launcher sets, stops segment from downloading on its own.
This is not the native Spinal Cord Toolbox; its sct_* commands are unaffected.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      task: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      threshold: { type: 'string' },
      'minimum-component-size': { type: 'string' },
      'test-time-augmentation': { type: 'boolean' },
      threads: { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  if (values.version) {
    console.log(packageJson.version);
  } else if (values.help || positionals.length === 0) {
    console.log(help);
  } else {
    const [command, ...rest] = positionals;
    const node = await import('../src/node.js');
    const cacheDir = values['cache-dir'] && { cacheDir: values['cache-dir'] };
    const onProgress = (text) => console.error(text);
    let report;
    if (command === 'self-check' && rest.length === 0) {
      report = await node.checkInstallation({ ...cacheDir });
    } else if (command === 'tasks' && rest.length === 0) {
      report = await node.listTasks({ ...cacheDir });
    } else if (command === 'download-models' && rest.length === 0) {
      if (values.all && values.task) throw new Error('Choose --all or --task, not both.');
      const { runnableTasks } = await import('../src/tasks.js');
      const tasks = values.all ? runnableTasks().map((task) => task.id) : values.task;
      report = await node.downloadModels({ ...cacheDir, ...(tasks && { tasks }), onProgress });
    } else if (command === 'segment') {
      if (rest.length !== 2) throw new Error('segment needs an input image and an output directory.');
      if (values.task?.length > 1) throw new Error('segment runs one --task at a time.');
      const number = (flag) => {
        if (values[flag] === undefined) return undefined;
        const value = Number(values[flag]);
        if (values[flag].trim() === '' || !Number.isFinite(value)) throw new Error(`--${flag} must be a number.`);
        return value;
      };
      report = await node.segment({
        input: rest[0],
        output: rest[1],
        ...(values.task && { task: values.task[0] }),
        threshold: number('threshold'),
        minimumComponentSize: number('minimum-component-size'),
        testTimeAugmentation: !!values['test-time-augmentation'],
        ...(values.threads && { threads: node.resolveThreads(values.threads) }),
        ...cacheDir,
        ...(values.offline && { offline: true }),
        onProgress,
      });
    } else {
      throw new Error(`Unknown command "${positionals.join(' ')}". Run sct-webapp --help.`);
    }
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

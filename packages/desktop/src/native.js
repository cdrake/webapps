import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { summarizeLabels } from '@neurodesk/webapp-components/automation';
import { isValidNifti1, parseNiftiHeader, parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import freesurferLut from '@neurodesk/webapp-components/automation/freesurfer-lut' with { type: 'json' };
import * as z from 'zod/v4';
import { describeFile } from './reports.js';

const LOG_LIMIT = 65536;
const provenanceSchema = z.looseObject({
  package: z.literal('synthseg'),
  version: z.string().min(1),
  model: z.string().min(1),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  executionProvider: z.enum(['cpu', 'metal']),
  ct: z.boolean(),
  fast: z.boolean(),
  input: z.string().min(1),
  output: z.string().min(1),
});

function runExecutable(binary, args, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let launchError;
    let killTimer;
    const stop = () => {
      if (killTimer) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    };
    child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]).subarray(-LOG_LIMIT); });
    child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-LOG_LIMIT); });
    child.once('error', error => { launchError = error; });
    child.once('close', (code, terminationSignal) => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(signal.reason);
      else if (launchError) reject(launchError);
      else if (code !== 0) {
        const diagnostic = stderr.length ? stderr : stdout;
        const error = new Error(`Native SynthSeg exited ${code === null ? `on ${terminationSignal}` : `with code ${code}`}: ${diagnostic.toString('utf8').trim()}`);
        error.code = 'NATIVE_EXIT';
        reject(error);
      } else resolve();
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

async function outputFile(path) {
  const file = await lstat(path);
  if (!file.isFile() || file.size === 0) throw new Error(`Native output must be a nonempty regular file: ${path}`);
}

export async function runNativeSynthseg({ contract, request, outputDirectory, signal, binary }) {
  if (!binary || !isAbsolute(binary)) throw new Error('NEURODESK_SYNTHSEG_BIN must name an absolute path to an installed SynthSeg executable.');
  if (typeof request.parameters.ct !== 'boolean') throw new Error('Native SynthSeg requires an explicit ct parameter (true or false); browser intensity detection is unavailable.');
  const deadline = AbortSignal.timeout(request.timeoutMs);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  active.throwIfAborted();
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if (!(await lstat(output)).isDirectory()) throw new Error('Native output directory must not be a symbolic link');
  if ((await readdir(output)).length) throw new Error('Output directory must be empty');
  const input = request.inputs.image[0];
  const inputDescriptor = await describeFile(input);
  const inputs = { image: contract.schemaVersion === 2 ? [inputDescriptor] : inputDescriptor };
  const labelsPath = join(output, 'labels.nii.gz');
  const sidecarPath = join(output, 'labels.json');
  const args = ['--i', input, '--o', labelsPath, '--quiet'];
  if (request.parameters.mode === 'fast') args.push('--fast');
  if (request.parameters.ct) args.push('--ct');
  await runExecutable(binary, args, active);
  active.throwIfAborted();
  await outputFile(labelsPath);
  await outputFile(sidecarPath);
  const provenance = provenanceSchema.parse(JSON.parse(await readFile(sidecarPath, 'utf8')));
  if (provenance.input !== await realpath(input) || resolve(provenance.output) !== labelsPath
      || provenance.ct !== request.parameters.ct || provenance.fast !== (request.parameters.mode === 'fast')) {
    throw new Error('Native SynthSeg provenance does not match the requested inputs, output or parameters');
  }
  const labelsBytes = gunzipSync(await readFile(labelsPath), { maxOutputLength: 2 ** 31 - 1 });
  if (!isValidNifti1(labelsBytes)) throw new Error('Native SynthSeg output is not a NIfTI-1 label map');
  const header = parseNiftiHeader(labelsBytes);
  const dimensions = [header.nx, header.ny, header.nz];
  const count = dimensions.reduce((product, dimension) => product * dimension, 1);
  if (header.datatype !== 8 || header.bitpix !== 32 || dimensions.some(dimension => dimension <= 0)
      || !Number.isInteger(header.voxOffset) || header.voxOffset < 352
      || header.voxOffset + count * 4 > labelsBytes.byteLength) {
    throw new Error('Native SynthSeg output has invalid int32 label-map dimensions or payload');
  }
  const image = parseNiftiVolume(labelsBytes, { OutputCtor: Float64Array });
  const measurements = summarizeLabels({ ...image, data: image.imageData }, freesurferLut);
  const { selector: _selector, minimum: _minimum, maximum: _maximum, ...declaration } = contract.artifacts.labels;
  const report = {
    schemaVersion: contract.schemaVersion,
    app: contract.app,
    appVersion: contract.appVersion,
    runId: randomUUID(),
    status: 'succeeded',
    ...(contract.schemaVersion === 2 && { operation: contract.operation }),
    inputs,
    parameters: request.parameters,
    provenance,
    measurements,
    artifacts: { labels: { ...declaration, ...(contract.schemaVersion === 2 && { role: 'labels' }), ...await describeFile(labelsPath) } },
  };
  active.throwIfAborted();
  const reportPath = join(output, 'report.json');
  const temporaryReport = join(output, '.report.json.partial');
  await writeFile(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', signal: active });
  active.throwIfAborted();
  await rename(temporaryReport, reportPath);
  const descriptor = await describeFile(reportPath);
  active.throwIfAborted();
  return { ...report, artifacts: { ...report.artifacts, report: { ...descriptor, type: 'neuro:report', mediaType: 'application/json' } } };
}

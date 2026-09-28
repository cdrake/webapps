import { mkdir, readFile, writeFile, stat, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseContract } from './contracts.js';
import { describeFile, verifyRunReport } from './reports.js';

export async function readJob(path) {
  const job = JSON.parse(await readFile(path, 'utf8'));
  if (job.schemaVersion !== 1 || !/^[a-z][a-z0-9-]*$/.test(job.app) || !Array.isArray(job.steps) || !job.steps.length) throw new Error('Invalid offline job');
  if (!Number.isSafeInteger(job.expectedDownloads) || job.expectedDownloads < 1) throw new Error('A batch job must declare its expected download count');
  if (job.timeoutMs !== undefined && (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs < 1)) throw new Error('Invalid job timeout');
  if (job.failSelector !== undefined && job.failSelector !== null && (typeof job.failSelector !== 'string' || !job.failSelector)) throw new Error('Invalid failure selector');
  if (job.automation) {
    job.automation.contract = parseContract(job.automation.contract);
    if (job.automation.contract.app !== job.app) throw new Error('Job contract app mismatch');
  }
  for (const step of job.steps) {
    if (!['upload', 'click', 'fill', 'select', 'check', 'wait'].includes(step.action) || typeof step.selector !== 'string') throw new Error('Invalid job step');
    if (step.timeoutMs !== undefined && (!Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1)) throw new Error('Invalid step timeout');
    if (step.condition && !['exists', 'enabled', 'visible', 'text', 'value', ...(job.automation ? ['state'] : [])].includes(step.condition)) throw new Error('Invalid wait condition');
    if (step.action === 'upload') {
      if (!Array.isArray(step.paths) || !step.paths.length) throw new Error('Upload requires local paths');
      step.paths = step.paths.map(value => resolve(dirname(path), value));
      for (const file of step.paths) if (!(await stat(file)).isFile()) throw new Error(`Input is not a file: ${file}`);
    }
  }
  return job;
}

const inspectElement = ({ selector, condition, value }) => {
  const element = document.querySelector(selector);
  if (!element) return false;
  if (condition === 'enabled') return !element.disabled;
  if (condition === 'text') return element.textContent.includes(value);
  if (condition === 'value') return element.value === value;
  if (condition === 'visible') return Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden';
  return true;
};

// Apps report failures in their status line with an `error` class. A job that
// only waits for success would otherwise sit until its timeout.
const DEFAULT_FAIL_SELECTOR = '#statusText.error';
const readFailure = selector => {
  const element = document.querySelector(selector);
  return element ? (element.textContent.trim() || 'unspecified error') : null;
};

const readRun = selector => {
  const element = document.querySelector(selector);
  return element ? JSON.parse(element.textContent) : null;
};

export async function runJob(contents, job, outputDirectory, { signal, onProgress = () => {} } = {}) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Output directory must be empty');
  const downloads = [];
  const activeDownloads = new Set();
  const names = new Set();
  const contract = job.automation?.contract;
  const reportPath = join(output, 'job-result.json');
  const partialReportPath = join(output, '.job-result.json.partial');
  const inputs = {};
  let downloadError;
  let currentArtifact;
  let previousRunId;
  let currentRunId;
  let snapshot;
  const deadline = Date.now() + (job.timeoutMs ?? 900000);
  const bounded = async promise => {
    let timer;
    let abort;
    try {
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        timer = setTimeout(() => reject(new Error('Job timed out waiting for the browser')), Math.max(1, deadline - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        Promise.resolve(promise).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  const evaluate = (fn, value) => bounded(contents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(value)})`));
  const onDownload = (_event, item, owner) => {
    if (owner !== contents) return;
    const filename = basename(item.getFilename());
    if (['job-result.json', '.job-result.json.partial', 'run.json'].includes(filename) || (contract && !currentArtifact)) {
      downloadError = new Error(`Unexpected output: ${filename}`);
      item.cancel();
      return;
    }
    if (names.has(filename)) {
      downloadError = new Error(`Duplicate output: ${filename}`);
      item.cancel();
      return;
    }
    names.add(filename);
    const role = currentArtifact;
    item.setSavePath(join(output, filename));
    activeDownloads.add(item);
    item.once('done', (_event, state) => {
      activeDownloads.delete(item);
      if (state !== 'completed') downloadError = new Error(`Output download ${filename}: ${state}`);
      else downloads.push({ filename, bytes: item.getReceivedBytes(), ...(role ? { role } : {}) });
    });
  };
  const check = async (timeoutMessage = `Job timed out after ${job.timeoutMs ?? 900000} ms`) => {
    signal?.throwIfAborted();
    if (downloadError) throw downloadError;
    if (Date.now() > deadline) throw new Error(timeoutMessage);
    if (contract) {
      snapshot = await evaluate(readRun, contract.lifecycle.snapshotSelector);
      if (snapshot && snapshot.runId !== previousRunId) {
        if (currentRunId && snapshot.runId !== currentRunId) throw new Error('App run changed during the job');
        currentRunId = snapshot.runId;
        if (snapshot.state === 'failed') throw new Error(`${job.app} reported an error: ${snapshot.message}`);
        if (snapshot.state === 'cancelled') throw new Error(`${job.app} was cancelled`);
        onProgress(snapshot);
      }
    } else {
      const failSelector = job.failSelector === null ? null : (job.failSelector ?? DEFAULT_FAIL_SELECTOR);
      if (failSelector) {
        const message = await evaluate(readFailure, failSelector);
        if (message !== null) throw new Error(`${job.app} reported an error: ${message}`);
      }
    }
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const wait = async step => {
    const stepDeadline = Date.now() + (step.timeoutMs ?? job.timeoutMs ?? 900000);
    for (;;) {
      await check(`Timed out waiting for ${step.selector} (${step.condition || 'exists'})`);
      if (step.condition === 'state') {
        if (snapshot?.state === step.value && snapshot.runId !== previousRunId) {
          currentRunId = snapshot.runId;
          return;
        }
      } else if (await evaluate(inspectElement, step)) return;
      if (Date.now() > stepDeadline) throw new Error(`Timed out waiting for ${step.selector} (${step.condition || 'exists'})`);
      await pause();
    }
  };
  contents.session.on('will-download', onDownload);
  let success = false;
  try {
    signal?.throwIfAborted();
    contents.debugger.attach('1.3');
    await evaluate(selectors => {
      for (const selector of selectors) document.querySelector(selector);
    }, [...job.steps.map(step => step.selector), ...(job.failSelector ? [job.failSelector] : [])]);
    if (contract) {
      for (const step of job.steps.filter(step => step.action === 'upload')) inputs[step.input] = await describeFile(step.paths[0]);
    }
    for (const step of job.steps) {
      console.error(`JOB ${step.action} ${step.selector}`);
      if (step.optional && !await evaluate(inspectElement, step)) continue;
      await wait({ ...step, condition: step.action === 'click' ? 'enabled' : step.condition });
      if (step.action === 'wait') continue;
      if (contract && (step.action === 'upload' || step.selector === contract.controls.run)) {
        previousRunId = (await evaluate(readRun, contract.lifecycle.snapshotSelector))?.runId;
        currentRunId = undefined;
      }
      if (step.action === 'upload') {
        const { root } = await bounded(contents.debugger.sendCommand('DOM.getDocument'));
        const { nodeId } = await bounded(contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: step.selector }));
        await bounded(contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: step.paths }));
      } else {
        currentArtifact = step.artifact;
        await evaluate(step => {
          const element = document.querySelector(step.selector);
          if (step.action === 'click') element.click();
          else {
            if (step.action === 'check') element.checked = Boolean(step.value);
            else element.value = step.value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, step);
        if (step.artifact) {
          while (!downloads.some(item => item.role === step.artifact)) {
            await check();
            await pause();
          }
          currentArtifact = undefined;
        }
      }
    }
    while (downloads.length < job.expectedDownloads) {
      // Keep the historical diagnostic for a missing or stuck output.
      if (Date.now() > deadline) throw new Error(`Expected ${job.expectedDownloads} outputs, received ${downloads.length}`);
      await check();
      await pause();
    }
    await check();
    if (downloadError) throw downloadError;
    if (names.size !== job.expectedDownloads || downloads.some(item => item.bytes === 0)) throw new Error('Batch output validation failed');
    if (contract && snapshot?.runId !== currentRunId) throw new Error('App run changed before its outputs were saved');
    const report = contract
      ? await verifyRunReport({ contract, snapshot, downloads, output, inputs })
      : { app: job.app, downloads };
    signal?.throwIfAborted();
    await writeFile(partialReportPath, `${JSON.stringify(report, null, 2)}\n`, { signal });
    signal?.throwIfAborted();
    await rename(partialReportPath, reportPath);
    signal?.throwIfAborted();
    success = true;
    return report;
  } finally {
    if (!success) {
      for (const item of activeDownloads) item.cancel();
      await rm(partialReportPath, { force: true });
      await rm(reportPath, { force: true });
    }
    contents.session.off('will-download', onDownload);
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}

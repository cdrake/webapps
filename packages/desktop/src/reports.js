import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export async function describeFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { filename: basename(path), bytes: (await stat(path)).size, sha256: hash.digest('hex') };
}

export async function verifyRunReport({ contract, snapshot, downloads, output, inputs }) {
  const report = snapshot?.report;
  if (snapshot?.state !== 'succeeded' || report?.status !== 'succeeded' || report.schemaVersion !== 1
      || report.app !== contract.app || report.runId !== snapshot.runId
      || report.appVersion !== contract.appVersion) throw new Error('App returned an invalid run report');
  if (!isDeepStrictEqual(Object.keys(report.artifacts ?? {}).sort(), Object.keys(contract.artifacts).sort())) {
    throw new Error('App report artifact roles do not match its contract');
  }
  for (const [role, expected] of Object.entries(inputs)) {
    const actual = report.inputs?.[role];
    if (!actual || ['filename', 'bytes', 'sha256'].some(key => actual[key] !== expected[key])) {
      throw new Error(`App report input does not match uploaded ${role}`);
    }
  }
  const artifacts = {};
  for (const download of downloads) {
    const file = await describeFile(join(output, download.filename));
    if (!file.bytes || file.bytes !== download.bytes) throw new Error(`Incomplete artifact: ${download.filename}`);
    if (download.role === 'report') {
      const saved = JSON.parse(await readFile(join(output, file.filename), 'utf8'));
      if (!isDeepStrictEqual(saved, report)) throw new Error('Downloaded report does not match the current run');
      artifacts.report = { ...file, type: 'neuro:report', mediaType: 'application/json' };
      continue;
    }
    const expected = report.artifacts[download.role];
    const declaration = contract.artifacts[download.role];
    if (!expected || ['filename', 'bytes', 'sha256'].some(key => file[key] !== expected[key])) {
      throw new Error(`Artifact checksum or filename mismatch: ${download.role}`);
    }
    if (expected.type !== declaration.type) throw new Error(`Artifact type mismatch: ${download.role}`);
    artifacts[download.role] = { ...expected, ...file };
  }
  if (Object.keys(artifacts).length !== Object.keys(contract.artifacts).length + 1) throw new Error('Missing declared artifacts');
  return { ...report, artifacts };
}

export async function verifyOperationReport({ operation, snapshot, downloads, output, inputs, parameters }) {
  const report = snapshot?.report;
  if (snapshot.state !== 'succeeded' || report?.status !== 'succeeded' || report.schemaVersion !== 2
      || report.app !== operation.app || report.appVersion !== operation.appVersion
      || report.operation !== operation.operation || report.runId !== snapshot.runId) {
    throw new Error('App returned an invalid operation report');
  }
  if (!isDeepStrictEqual(report.inputs, inputs)) throw new Error('Operation input hashes do not match uploaded files');
  if (!isDeepStrictEqual(report.parameters, parameters)) throw new Error('Operation parameters do not match the request');
  if (operation.mode === 'viewer' && (!report.summary || !Object.keys(report.summary).length)) {
    throw new Error('Viewer operation did not report source and view state');
  }
  const counts = new Map(Object.keys(operation.artifacts).map(role => [role, 0]));
  const declared = Object.entries(report.artifacts ?? {});
  const ids = new Set(declared.map(([id]) => id));
  if (ids.has('report')) throw new Error('The report artifact ID is reserved');
  for (const [id, descriptor] of declared) {
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`Invalid artifact ID: ${id}`);
    const declaration = operation.artifacts[descriptor.role];
    if (!declaration) throw new Error(`Unexpected artifact role: ${descriptor.role}`);
    const types = Array.isArray(declaration.type) ? declaration.type : [declaration.type];
    if (!types.includes(descriptor.type)) throw new Error(`Artifact type mismatch: ${id}`);
    if (declaration.mediaType !== 'application/octet-stream' && descriptor.mediaType !== declaration.mediaType) {
      throw new Error(`Artifact media type mismatch: ${id}`);
    }
    for (const key of ['space', 'labelSystem']) {
      if (declaration[key] !== undefined && descriptor[key] !== declaration[key]) throw new Error(`Artifact ${key} mismatch: ${id}`);
    }
    counts.set(descriptor.role, counts.get(descriptor.role) + 1);
  }
  for (const [role, count] of counts) {
    const { minimum, maximum } = operation.artifacts[role];
    if (count < minimum || (maximum !== undefined && count > maximum)) throw new Error(`Artifact cardinality mismatch: ${role}`);
  }
  if (downloads.length !== declared.length + 1) throw new Error('Operation output count mismatch');
  const artifacts = {};
  for (const download of downloads) {
    if (artifacts[download.role]) throw new Error(`Duplicate artifact download: ${download.role}`);
    const file = await describeFile(join(output, download.filename));
    if (!file.bytes || file.bytes !== download.bytes) throw new Error(`Incomplete artifact: ${download.filename}`);
    if (download.role === 'report') {
      const saved = JSON.parse(await readFile(join(output, file.filename), 'utf8'));
      if (!isDeepStrictEqual(saved, report)) throw new Error('Downloaded report does not match the current operation');
      artifacts.report = { ...file, type: 'neuro:report', role: 'report', mediaType: 'application/json' };
    } else {
      const expected = report.artifacts[download.role];
      if (!expected || ['filename', 'bytes', 'sha256'].some(key => file[key] !== expected[key])) {
        throw new Error(`Artifact checksum or filename mismatch: ${download.role}`);
      }
      artifacts[download.role] = { ...expected, ...file };
    }
  }
  if (!artifacts.report || declared.some(([id]) => !artifacts[id])) throw new Error('Missing operation artifacts');
  return { ...report, artifacts };
}

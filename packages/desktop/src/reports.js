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

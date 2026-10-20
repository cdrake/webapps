import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const marker = '.lint-coverage-canary';
const canaryName = /^(promise-canary|type-canary|lint-canary|lint-alias)-[A-Za-z0-9]{6}$/;

async function processIdentity(pid) {
  const [boot, namespace, stat] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readlink(`/proc/${pid}/ns/pid`),
    readFile(`/proc/${pid}/stat`, 'utf8'),
  ]);
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return { boot: boot.trim(), namespace, start };
}

export async function canaryDirectory(root, prefix) {
  const directory = await mkdtemp(join(root, prefix));
  // Without a process identity, preserve the directory if this run is interrupted.
  const identity = await processIdentity(process.pid).catch(() => null);
  await writeFile(join(directory, marker), JSON.stringify({ version: 1, pid: process.pid, ...identity }), { flag: 'wx' });
  return directory;
}

async function ownerExited(directory) {
  let owner;
  let local;
  try {
    owner = JSON.parse(await readFile(join(directory, marker), 'utf8'));
    local = await processIdentity(process.pid);
  } catch {
    return false;
  }
  if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.start !== 'string' || !/^(0|[1-9][0-9]*)$/.test(owner.start) || owner.boot !== local.boot || owner.namespace !== local.namespace) return false;
  try {
    return (await processIdentity(owner.pid)).start !== owner.start;
  } catch (error) {
    // Only a positively absent process permits deletion; permission failures do not.
    return error.code === 'ENOENT';
  }
}

export async function cleanupCanaries(root, parents) {
  for (const parent of new Set(parents)) {
    const entries = await readdir(join(root, parent)).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!canaryName.test(entry)) continue;
      const directory = join(root, parent, entry);
      const info = await lstat(directory).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info?.isDirectory() || !(await ownerExited(directory))) continue;
      const tracked = spawnSync('git', ['ls-files', '--', join(parent, entry)], { cwd: root, encoding: 'utf8' });
      if (tracked.status === 0 && tracked.stdout === '') await rm(directory, { recursive: true, force: true });
    }
  }
}

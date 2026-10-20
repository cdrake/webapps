import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { canaryDirectory, cleanupCanaries } from '../test-utils/lint-canaries.mjs';

const helper = new URL('../test-utils/lint-canaries.mjs', import.meta.url).href;

test('cleanup preserves active canaries and removes only untracked canaries whose owner exited', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lint-canary-cleanup-'));
  let child;
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    await mkdir(join(root, 'src'));
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { canaryDirectory } from ${JSON.stringify(helper)};
      import { writeFile } from 'node:fs/promises';
      const directories = await Promise.all(['lint-canary-', 'promise-canary-', 'type-canary-'].map(prefix => canaryDirectory(process.argv[1], 'src/' + prefix)));
      for (const directory of directories) await writeFile(directory + '/canary.js', 'missingBinding();');
      console.log(JSON.stringify(directories));
      setInterval(() => {}, 1000);
    `, root], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line');
    lines.close();
    const [active, tracked, foreign] = JSON.parse(line);
    await cleanupCanaries(root, ['src/']);
    await access(join(active, 'canary.js'));
    assert.equal(spawnSync('git', ['add', '--', tracked], { cwd: root }).status, 0);
    const marker = join(foreign, '.lint-coverage-canary');
    const owner = JSON.parse(await readFile(marker, 'utf8'));
    await writeFile(marker, JSON.stringify({ ...owner, namespace: 'another-pid-namespace' }));
    const exit = once(child, 'exit');
    child.kill();
    await exit;
    child = null;
    await cleanupCanaries(root, ['src/']);
    await assert.rejects(access(active), { code: 'ENOENT' });
    await access(join(tracked, 'canary.js'));
    await access(join(foreign, 'canary.js'));
  } finally {
    if (child) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('cleanup preserves unmarked, malformed, legacy and symlink directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lint-canary-cleanup-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    await mkdir(join(root, 'src'));
    const active = await canaryDirectory(root, 'src/lint-canary-');
    const invalidOwner = await canaryDirectory(root, 'src/type-canary-');
    const marker = join(invalidOwner, '.lint-coverage-canary');
    const owner = JSON.parse(await readFile(marker, 'utf8'));
    await writeFile(marker, JSON.stringify({ ...owner, start: 'garbage' }));
    const unmarked = await mkdtemp(join(root, 'src/promise-canary-'));
    const malformed = await mkdtemp(join(root, 'src/type-canary-'));
    await writeFile(join(malformed, '.lint-coverage-canary'), '{');
    const legacy = await mkdtemp(join(root, 'src/lint-alias-'));
    await writeFile(join(legacy, '.lint-coverage-canary'), '');
    const linked = join(root, 'src/lint-canary-ABC123');
    await symlink(unmarked, linked, 'junction');
    await cleanupCanaries(root, ['src/', 'absent/']);
    for (const directory of [active, invalidOwner, unmarked, malformed, legacy, linked]) await access(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

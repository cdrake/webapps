import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { COMMANDS, EXAMPLE_SHA256, compareWithBrowser, downloadName, pinnedExamples, readReference, summarize, writeReference } from '../../../packages/niimath/validation/reference.mjs';

// Runs every command the app offers on every pinned example through the app itself (automation,
// niimath worker, built assets) and compares each download with
// packages/niimath/validation/browser-reference.json, which the command line's release check also
// uses. Runs only when NIIMATH_BROWSER_REFERENCE is "check" or "write" ("write" records the result).
const mode = process.env.NIIMATH_BROWSER_REFERENCE;
const niimath = JSON.parse(await readFile(new URL('../node_modules/@niivue/niimath/package.json', import.meta.url), 'utf8'));
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test('every app command on every pinned example matches the browser reference', async ({ page, browser }) => {
  test.skip(mode !== 'check' && mode !== 'write', 'set NIIMATH_BROWSER_REFERENCE=check or write');
  test.setTimeout(15 * 60_000);
  const examples = await pinnedExamples();
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  const outputs = {};
  const started = performance.now();
  for (const example of examples) {
    outputs[example.id] = {};
    const buffer = await readFile(example.path);
    for (const command of COMMANDS) {
      await page.locator('#neurodesk-input-transfer').setInputFiles({ name: example.name, mimeType: 'application/gzip', buffer });
      await dispatch(page, 'adopt', { role: 'image' });
      await dispatch(page, 'start', { operation: 'process', parameters: { command } });
      await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 5 * 60_000, intervals: [500] }).not.toBe('running');
      const snapshot = await dispatch(page, 'snapshot');
      expect(snapshot.state, `${example.id} ${command}: ${JSON.stringify(snapshot.error)}`).toBe('succeeded');
      const downloaded = page.waitForEvent('download');
      await dispatch(page, 'download', { artifactId: 'result' });
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(downloadName(command));
      outputs[example.id][command] = { name: downloadName(command), ...summarize(await readFile(await download.path())) };
    }
  }
  const { appVersion } = (await dispatch(page, 'snapshot')).report;
  if (mode === 'write') {
    await writeReference({
      inputs: EXAMPLE_SHA256,
      commands: COMMANDS,
      browser: {
        path: 'apps/niimath/e2e/reference.spec.js: the app\'s process automation, niimath worker, built assets',
        app: `niimath ${appVersion}`,
        niimath: `@niivue/niimath ${niimath.version}`,
        browser: `Chromium ${browser.version()}`,
        seconds: Math.round((performance.now() - started) / 1000),
        outputs,
      },
    });
    return;
  }
  const reference = await readReference();
  expect(reference.browser.niimath).toBe(`@niivue/niimath ${niimath.version}`);
  const failures = [];
  for (const example of examples) {
    for (const command of COMMANDS) {
      for (const [passed, line] of compareWithBrowser(`web app ${example.id} ${command}`, outputs[example.id][command], reference.browser.outputs[example.id][command])) {
        if (!passed) failures.push(line);
      }
    }
  }
  expect(failures).toEqual([]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { macNotarizeConfig, retryTransient, stapleApp, transientStapleError } from '../../../scripts/desktop/mac-notarize.mjs';

const directory = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(directory, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');

const stapleOutput = (urlError) => `Failed to staple your application with code: 68

Processing: /Users/runner/work/webapps/webapps/packages/desktop/release/mac-arm64/neurodesk-webapps.app
Domain is api.apple-cloudkit.com
error is Error Domain=NSURLErrorDomain Code=${urlError}
CloudKit's response is inconsistent with expections: (null)
The staple and validate action failed! Error 68.`;
const connectionLost = new Error(stapleOutput('-1005 "The network connection was lost."'));
const tlsTrust = new Error(stapleOutput('-1202 "The certificate for this server is invalid."'));
const ticketNotFound = new Error('Failed to staple your application with code: 65\n\nThe staple and validate action failed! Error 65.');
const notaryLost = new Error('Failed to complete notarization: Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."');
const credentials = { APPLE_ID: 'id', APPLE_APP_SPECIFIC_PASSWORD: 'secret', APPLE_TEAM_ID: 'team' };
const packager = { appInfo: { productFilename: 'neurodesk-webapps' } };
const appPath = '/release/mac-arm64/neurodesk-webapps.app';

test('only a staple failure on a retryable transport error, or stapler code 68 alone, is transient', () => {
  assert.equal(transientStapleError(connectionLost), true);
  assert.equal(transientStapleError(new Error(stapleOutput('-1001 "The request timed out."'))), true);
  assert.equal(transientStapleError(new Error(stapleOutput('-1009 "The Internet connection appears to be offline."'))), true);
  assert.equal(transientStapleError(new Error(stapleOutput('-1004 "Could not connect to the server."'))), true);
  assert.equal(transientStapleError(new Error('Failed to staple your application with code: 68\n\nCloudKit query for ticket failed.')), true);
  assert.equal(transientStapleError(tlsTrust), false);
  assert.equal(transientStapleError(ticketNotFound), false);
  assert.equal(transientStapleError(notaryLost), false);
  assert.equal(transientStapleError(new Error('Invalid signature')), false);
});

test('a transient staple failure is retried with backoff, then succeeds', async () => {
  const outcomes = [connectionLost, connectionLost, 'stapled'];
  const log = [];
  const waits = [];
  const result = await retryTransient(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }, { attempts: 4, delay: 1000, sleep: async ms => { waits.push(ms); }, log: line => log.push(line) });
  assert.equal(result, 'stapled');
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(log.length, 2);
  assert.match(log[0], /attempt 1 of 4.*retry in 1 s/s);
  assert.match(log[0], /network connection was lost/);
  assert.match(log[1], /attempt 2 of 4.*retry in 2 s/s);
});

test('a permanent TLS error is thrown at once, without a retry', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryTransient(() => { calls += 1; throw tlsTrust; }, { attempts: 4, delay: 1000, sleep: async ms => { waits.push(ms); } }), tlsTrust);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('a transient failure on the last attempt is thrown', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryTransient(() => { calls += 1; throw connectionLost; }, { attempts: 3, delay: 500, sleep: async ms => { waits.push(ms); }, log: () => {} }), connectionLost);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('the hook replaces electron-builder notarization only on macOS with Apple credentials', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  assert.deepEqual(macNotarizeConfig('darwin', {}), {});
  assert.deepEqual(macNotarizeConfig('win32', credentials), {});
  const config = macNotarizeConfig('darwin', credentials);
  assert.equal(config.mac.notarize, false);
  assert.equal(typeof config.afterSign, 'function');
  const merged = await getConfig(directory, null, config);
  assert.equal(merged.mac.notarize, false);
  assert.deepEqual(merged.mac.target, [{ target: 'zip', arch: ['arm64'] }]);
  await assert.rejects(config.afterSign({ appOutDir: '/release', electronPlatformName: 'win32', packager }), /Expected macOS packaging/);
});

function hook(outcomes) {
  const calls = [];
  const waits = [];
  const { afterSign } = macNotarizeConfig('darwin', credentials, {
    notarize: async options => {
      calls.push(['notarize', options]);
      const outcome = outcomes.notarize.shift();
      if (outcome) throw outcome;
    },
    staple: async path => {
      calls.push(['staple', path]);
      const outcome = outcomes.staple.shift();
      if (outcome) throw outcome;
    },
    sleep: async ms => { waits.push(ms); },
    log: () => {},
  });
  return { calls, waits, run: () => afterSign({ appOutDir: '/release/mac-arm64', electronPlatformName: 'darwin', packager }) };
}

test('the hook notarizes once, then retries only stapling after a transient staple failure', async () => {
  const { calls, waits, run } = hook({ notarize: [connectionLost], staple: [connectionLost, null] });
  await run();
  assert.deepEqual(calls, [
    ['notarize', { tool: 'notarytool', appPath, appleId: 'id', appleIdPassword: 'secret', teamId: 'team' }],
    ['staple', appPath],
    ['staple', appPath],
  ]);
  assert.deepEqual(waits, [15000, 30000]);
});

test('a permanent TLS error while stapling fails the hook at once', async () => {
  const { calls, waits, run } = hook({ notarize: [tlsTrust], staple: [] });
  await assert.rejects(run(), tlsTrust);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a notarization failure is not retried', async () => {
  const invalid = new Error('Failure: Notarization failed. The signature of the binary is invalid.');
  const { calls, waits, run } = hook({ notarize: [invalid], staple: [] });
  await assert.rejects(run(), invalid);
  assert.deepEqual(calls.map(([name]) => name), ['notarize']);
  assert.deepEqual(waits, []);
});

test('a lost connection after submission does not submit the app again', async () => {
  const { calls, waits, run } = hook({ notarize: [notaryLost], staple: [] });
  await assert.rejects(run(), notaryLost);
  assert.deepEqual(calls.map(([name]) => name), ['notarize']);
  assert.deepEqual(waits, []);
});

test('the production hook uses the public notarize of the @electron/notarize electron-builder pins', () => {
  const appBuilder = createRequire(builderRequire.resolve('app-builder-lib'));
  assert.equal(typeof appBuilder('@electron/notarize').notarize, 'function');
  assert.equal(appBuilder('@electron/notarize').stapleApp, undefined);
});

test('stapleApp reports a missing xcrun as its own error, not a staple failure', { skip: process.platform === 'darwin' }, async (t) => {
  const release = await mkdtemp(join(tmpdir(), 'release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  await assert.rejects(stapleApp(join(release, 'neurodesk-webapps.app')), error => error.code === 'ENOENT' && error.path === 'xcrun' && !transientStapleError(error));
});

test('stapleApp turns a stapler exit code and its output into the error the predicate reads', { skip: process.platform === 'win32' }, async (t) => {
  const release = await mkdtemp(join(tmpdir(), 'release-'));
  t.after(() => rm(release, { recursive: true, force: true }));
  await writeFile(join(release, 'xcrun'), `#!/bin/sh\necho "$*"\necho 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'\nexit 68\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${release}:${path}`;
  t.after(() => { process.env.PATH = path; });
  await assert.rejects(stapleApp(join(release, 'neurodesk-webapps.app')), error => {
    assert.match(error.message, /^Failed to staple your application with code: 68\n\nstapler staple -v neurodesk-webapps.app\n/);
    return transientStapleError(error);
  });
});

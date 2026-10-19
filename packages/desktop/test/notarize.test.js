import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { macNotarizeConfig, retryTransient, transientNetworkError } from '../../../scripts/desktop/mac-notarize.mjs';

const directory = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(directory, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder'));
const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js');

const stapleFailure = new Error(`Failed to staple your application with code: 68

Processing: /Users/runner/work/webapps/webapps/packages/desktop/release/mac-arm64/neurodesk-webapps.app
Domain is api.apple-cloudkit.com
error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."
CloudKit's response is inconsistent with expections: (null)
The staple and validate action failed! Error 68.`);
const invalidSignature = new Error('Failed to staple your application with code: 65\n\nThe staple and validate action failed! Error 65.');

test('a dropped connection to Apple is transient, an invalid signature is not', () => {
  assert.equal(transientNetworkError(stapleFailure), true);
  assert.equal(transientNetworkError(new Error('Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."')), true);
  assert.equal(transientNetworkError(invalidSignature), false);
  assert.equal(transientNetworkError(new Error('Invalid signature')), false);
});

test('stapling retries a transient failure with backoff, then succeeds', async () => {
  const outcomes = [stapleFailure, stapleFailure, 'stapled'];
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

test('a permanent failure is thrown at once, without a retry', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryTransient(() => { calls += 1; throw invalidSignature; }, { attempts: 4, delay: 1000, sleep: async ms => { waits.push(ms); } }), invalidSignature);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('a transient failure on the last attempt is thrown', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryTransient(() => { calls += 1; throw stapleFailure; }, { attempts: 3, delay: 500, sleep: async ms => { waits.push(ms); }, log: () => {} }), stapleFailure);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('the hook replaces electron-builder notarization only on macOS with Apple credentials, from the pinned @electron/notarize', async (t) => {
  t.mock.method(builderRequire('builder-util').log, 'info', console.error);
  const credentials = { APPLE_ID: 'id', APPLE_APP_SPECIFIC_PASSWORD: 'secret', APPLE_TEAM_ID: 'team' };
  assert.deepEqual(macNotarizeConfig('darwin', {}), {});
  assert.deepEqual(macNotarizeConfig('win32', credentials), {});
  const config = macNotarizeConfig('darwin', credentials);
  assert.equal(config.mac.notarize, false);
  assert.equal(typeof config.afterSign, 'function');
  const merged = await getConfig(directory, null, config);
  assert.equal(merged.mac.notarize, false);
  assert.deepEqual(merged.mac.target, [{ target: 'zip', arch: ['arm64'] }]);
});

test('the hook notarizes, then staples the signed app with the retry', async () => {
  const credentials = { APPLE_ID: 'id', APPLE_APP_SPECIFIC_PASSWORD: 'secret', APPLE_TEAM_ID: 'team' };
  const calls = [];
  const waits = [];
  let stapleAttempts = 0;
  const { afterSign } = macNotarizeConfig('darwin', credentials, {
    notarize: async options => { calls.push(['notarize', options]); },
    staple: async options => {
      stapleAttempts += 1;
      calls.push(['staple', options]);
      if (stapleAttempts === 1) throw stapleFailure;
    },
    sleep: async ms => { waits.push(ms); },
    log: () => {},
  });
  const packager = { appInfo: { productFilename: 'neurodesk-webapps' } };
  await afterSign({ appOutDir: '/release/mac-arm64', electronPlatformName: 'darwin', packager });
  assert.deepEqual(calls, [
    ['notarize', { appPath: '/release/mac-arm64/neurodesk-webapps.app', appleId: 'id', appleIdPassword: 'secret', teamId: 'team' }],
    ['staple', { appPath: '/release/mac-arm64/neurodesk-webapps.app' }],
    ['staple', { appPath: '/release/mac-arm64/neurodesk-webapps.app' }],
  ]);
  assert.deepEqual(waits, [15000]);
  await assert.rejects(afterSign({ appOutDir: '/release', electronPlatformName: 'win32', packager }), /Expected macOS packaging/);
});

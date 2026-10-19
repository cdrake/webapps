import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { basename, dirname, join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../packages/desktop/package.json'));
// Resolve @electron/notarize the way electron-builder does, so the hook runs the
// version builder pins rather than one the desktop package would have to track.
function electronNotarize() {
  const builder = createRequire(require.resolve('electron-builder'));
  return createRequire(builder.resolve('app-builder-lib'))('@electron/notarize');
}

// NSURLErrorDomain transport failures a retry can outlast: connection lost,
// timed out, offline, cannot connect. Trust errors such as -1202 are not.
const TRANSIENT_URL_CODES = new Set([-1005, -1001, -1009, -1004]);
export function transientStapleError(error) {
  const message = String(error?.message ?? error);
  const staple = message.match(/^Failed to staple your application with code: (\d+)/);
  if (!staple) return false;
  const url = message.match(/NSURLErrorDomain Code=(-\d+)/);
  if (url) return TRANSIENT_URL_CODES.has(Number(url[1]));
  return Number(staple[1]) === 68;
}

export async function retryTransient(run, { attempts = 4, delay = 15000, sleep = wait, log = console.log } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= attempts || !transientStapleError(error)) throw error;
      const pause = delay * 2 ** (attempt - 1);
      log(`Transient network error stapling on attempt ${attempt} of ${attempts}, retry in ${pause / 1000} s:\n${error.message}`);
      await sleep(pause);
    }
  }
}

// Same command and failure message as @electron/notarize's stapleApp, which the
// package does not export.
export function stapleApp(appPath) {
  return new Promise((resolvePromise, reject) => {
    execFile('xcrun', ['stapler', 'staple', '-v', basename(appPath)], { cwd: dirname(appPath) }, (error, stdout, stderr) => {
      if (!error) return resolvePromise();
      if (typeof error.code !== 'number') return reject(error);
      reject(new Error(`Failed to staple your application with code: ${error.code}\n\n${stdout}${stderr}`));
    });
  });
}

export function macNotarizeConfig(platform = process.platform, env = process.env, tools = {}) {
  if (platform !== 'darwin' || !env.APPLE_ID) return {};
  const credentials = { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  const { notarize = electronNotarize().notarize, staple = stapleApp, sleep, log = console.log } = tools;
  return {
    // electron-builder would otherwise notarize inside signApp, before afterSign,
    // and the hook would submit the app a second time.
    mac: { notarize: false },
    afterSign: async ({ appOutDir, electronPlatformName, packager }) => {
      if (electronPlatformName !== 'darwin') throw new Error('Expected macOS packaging');
      const appPath = join(appOutDir, `${packager.appInfo.productFilename}.app`);
      // The first attempt submits and staples through the public API; a later
      // attempt only staples again, so the app is never submitted twice.
      await retryTransient(attempt => attempt === 1 ? notarize({ tool: 'notarytool', appPath, ...credentials }) : staple(appPath), { sleep, log });
      log(`notarization successful: ${appPath}`);
    },
  };
}

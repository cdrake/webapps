import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../../packages/desktop/package.json'));
// electron-builder's own notarization lives in @electron/notarize; reach it through
// the same resolution chain so the hook runs the pinned version builder would.
const notarizer = () => {
  const builder = createRequire(require.resolve('electron-builder'));
  const appBuilder = createRequire(builder.resolve('app-builder-lib'));
  return createRequire(appBuilder.resolve('@electron/notarize'));
};

const TRANSIENT = /NSURLErrorDomain|network connection was lost|with code: 68\b/;
export function transientNetworkError(error) {
  return TRANSIENT.test(String(error?.message ?? error));
}

export async function retryTransient(run, { attempts = 4, delay = 15000, sleep = wait, log = console.log } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !transientNetworkError(error)) throw error;
      const pause = delay * 2 ** (attempt - 1);
      log(`Transient network error on attempt ${attempt} of ${attempts}, retry in ${pause / 1000} s:\n${error.message}`);
      await sleep(pause);
    }
  }
}

export function macNotarizeConfig(platform = process.platform, env = process.env, tools = {}) {
  if (platform !== 'darwin' || !env.APPLE_ID) return {};
  const credentials = { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  const { sleep, log } = tools;
  return {
    // @electron/notarize's own staple retry gives up after about seven seconds,
    // shorter than the outages that failed the nightly release.
    mac: { notarize: false },
    afterSign: async ({ appOutDir, electronPlatformName, packager }) => {
      if (electronPlatformName !== 'darwin') throw new Error('Expected macOS packaging');
      const appPath = join(appOutDir, `${packager.appInfo.productFilename}.app`);
      const notarize = tools.notarize ?? notarizer()('@electron/notarize/lib/notarytool.js').notarizeAndWaitForNotaryTool;
      const staple = tools.staple ?? notarizer()('@electron/notarize/lib/staple.js').stapleApp;
      await retryTransient(() => notarize({ appPath, ...credentials }), { sleep, log });
      await retryTransient(() => staple({ appPath }), { sleep, log });
      (log ?? console.log)(`notarization successful: ${appPath}`);
    },
  };
}

import { defineConfig } from '@playwright/test';
import { e2eTier } from './e2e-tier.mjs';

export function staticAppPlaywrightConfig({ port }) {
  const baseURL = `http://localhost:${port}`;
  return defineConfig({
    ...e2eTier,
    testDir: './e2e',
    webServer: {
      command: `pnpm vendor && bash web/run.sh ${port}`,
      url: `${baseURL}/harness.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000
    },
    use: {
      baseURL,
      ...(process.env.PW_EXECUTABLE_PATH
        ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
        : {})
    }
  });
}

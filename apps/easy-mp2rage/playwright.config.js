import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'node ../../scripts/build-static.mjs && node ../../scripts/theme-app-dist.mjs --app easy-mp2rage && node ../../scripts/dev-server.mjs --dir dist --port 4329',
    url: 'http://localhost:4329/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4329/' },
});

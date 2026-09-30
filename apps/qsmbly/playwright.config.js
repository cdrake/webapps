import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'pnpm vendor && node ../../scripts/dev-server.mjs --dir . --port 4328',
    url: 'http://localhost:4328/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4328/' },
});

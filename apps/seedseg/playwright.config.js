import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'pnpm vendor && bash web/run.sh 4327',
    url: 'http://localhost:4327/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4327/' },
});

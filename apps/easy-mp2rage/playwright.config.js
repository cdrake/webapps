import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'node ../../scripts/vendor-components.mjs && node ../../scripts/dev-server.mjs --dir web --port 4329',
    url: 'http://localhost:4329/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4329/' },
});

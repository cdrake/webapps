import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 60000, workers: 1,
  webServer: {
    command: 'node ../../scripts/vendor-components.mjs && pnpm build && python3 -m http.server 4186 --bind 127.0.0.1 --directory dist',
    url: 'http://127.0.0.1:4186/', reuseExistingServer: !process.env.CI, timeout: 180000,
  },
  use: { baseURL: 'http://127.0.0.1:4186/' },
});

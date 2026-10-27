import { defineConfig } from '@playwright/test';

const port = process.env.SEEDSEG_E2E_PORT || '4327';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  webServer: {
    command: `${process.env.NEURODESK_E2E_PREBUILT ? '' : 'pnpm build && '}node ../../scripts/dev-server.mjs --dir dist --app seedseg --port ${port}`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: `http://localhost:${port}/` },
});

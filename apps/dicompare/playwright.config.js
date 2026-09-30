import { vitePreviewPlaywrightConfig } from '../../test-utils/playwright-vite-preview.mjs';

export default vitePreviewPlaywrightConfig({
  port: 4332,
  host: '127.0.0.1',
  basePath: '/dicompare/',
  swiftShaderWebGL: true,
  exemptLoopbackFromProxy: true,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
});

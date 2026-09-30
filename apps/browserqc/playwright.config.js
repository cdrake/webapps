import { vitePreviewPlaywrightConfig } from '../../test-utils/playwright-vite-preview.mjs';

export default vitePreviewPlaywrightConfig({
  port: 4334,
  host: '127.0.0.1',
  basePath: '/browserqc/',
  use: { launchOptions: { args: process.platform === 'linux' ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface', '--no-proxy-server'] : ['--no-proxy-server'] } },
  exemptLoopbackFromProxy: true,
  timeout: 900_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
});

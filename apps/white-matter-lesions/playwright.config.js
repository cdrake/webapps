import { defineConfig } from "@playwright/test";

// Serves the built output so the shared preview headers and worker/wasm asset paths are exercised.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120000,
  workers: 1,
  webServer: {
    command: "pnpm preview --port 4191 --strictPort",
    url: "http://127.0.0.1:4191/white-matter-lesions/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://127.0.0.1:4191/white-matter-lesions/",
    launchOptions: { args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"] },
  },
});

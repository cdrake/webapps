import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "nesvor",
  plugins: [isolationFallback()],
  define: { "import.meta.env.NESVOR_LOCAL_MODELS": Boolean(process.env.NESVOR_MODEL_DIR) },
  resolve: { conditions: ["onnxruntime-web-use-extern-wasm"] },
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
});

// Pull requests skip tests tagged @slow: full pipelines on real data and
// byte-for-byte browser reference checks. Pushes to main, the nightly run and
// release.yml run every test. Spread into an app's Playwright config:
//   export default defineConfig({ ...e2eTier, testDir: './e2e' });
export const e2eTier = process.env.NEURODESK_E2E_SKIP_SLOW === '1' ? { grepInvert: /@slow/ } : {};

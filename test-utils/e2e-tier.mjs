// CI's Playwright settings for an app's config, from the environment.
// Pull requests skip tests tagged @slow: full pipelines on real data and
// byte-for-byte browser reference checks. Pushes to main, the nightly run and
// release.yml run every test. NEURODESK_E2E_SHARD ("1/2") runs one shard of an
// app whose registry entry sets ci.e2e_shards. Spread into an app's Playwright config:
//   export default defineConfig({ ...e2eTier, testDir: './e2e' });
const [current, total] = (process.env.NEURODESK_E2E_SHARD || '').split('/').map(Number);
export const e2eTier = {
  ...(process.env.NEURODESK_E2E_SKIP_SLOW === '1' ? { grepInvert: /@slow/ } : {}),
  ...(total > 1 ? { shard: { current, total } } : {}),
};

const [current, total] = (process.env.NEURODESK_E2E_SHARD || '').split('/').map(Number);
export const e2eTier = {
  ...(process.env.NEURODESK_E2E_SKIP_SLOW === '1' ? { grepInvert: /@slow/ } : {}),
  ...(total > 1 ? { shard: { current, total } } : {}),
};

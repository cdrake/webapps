export const e2eTier = process.env.NEURODESK_E2E_SKIP_SLOW === '1' ? { grepInvert: /@slow/ } : {};

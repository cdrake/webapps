import manifest from '../model.manifest.json' with { type: 'json' };

const withUrl = asset => ({ ...asset, url: asset.url ?? `${manifest.base_url}${asset.filename}` });

// v2: the nnU-Net ResEnc networks of the five cross-validation folds, in fold order.
export const NETWORK_ASSETS = manifest.assets.filter(asset => asset.model === 'v2').map(asset => ({
  ...withUrl(asset),
  fold: Number(asset.id.slice(4)),
}));
export const FOLDS = NETWORK_ASSETS.map(asset => asset.fold);
export const DEFAULT_FOLDS = [0];
export const V2_PLAN = manifest.v2_plan;

// v1 (legacy): the four 3D U-Net checkpoints of the previous release, in published order.
export const LEGACY_ASSETS = manifest.assets.filter(asset => asset.model === 'v1').map(asset => ({
  ...withUrl(asset),
  seed: Number(asset.id.slice(4)),
}));
export const MODEL_SEEDS = LEGACY_ASSETS.map(asset => asset.seed);

export const MODEL_ASSETS = [...NETWORK_ASSETS, ...LEGACY_ASSETS];

export function resolveModels(selected = MODEL_SEEDS) {
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 4) {
    throw new Error('Select one to four distinct SeedSeg models.');
  }
  const ids = selected.map(value => {
    const asset = LEGACY_ASSETS.find(asset => [asset.id, asset.filename, String(asset.seed)].includes(String(value)));
    if (!asset) throw new Error(`Unknown SeedSeg model "${value}". Choose ${MODEL_SEEDS.join(', ')}.`);
    return asset.id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Select distinct SeedSeg models.');
  // The browser's checkboxes always run in published model order.
  return LEGACY_ASSETS.filter(asset => ids.includes(asset.id));
}

/** Networks to average, in fold order, as the browser's network checkboxes run them. */
export function resolveFolds(selected = DEFAULT_FOLDS) {
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > NETWORK_ASSETS.length) {
    throw new Error(`Select one to ${NETWORK_ASSETS.length} distinct SeedSeg networks.`);
  }
  const folds = selected.map(value => {
    const fold = typeof value === 'string' && /^\s*\d\s*$/.test(value) ? Number(value) : value;
    if (!FOLDS.includes(fold)) throw new Error(`Unknown SeedSeg network fold "${value}". Choose ${FOLDS.join(', ')}.`);
    return fold;
  });
  if (new Set(folds).size !== folds.length) throw new Error('Select distinct SeedSeg networks.');
  return NETWORK_ASSETS.filter(asset => folds.includes(asset.fold));
}

export function validateSelection({ threshold = 0.1, nMarkers = 3 } = {}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('Threshold must be a finite number in [0, 1].');
  }
  if (!Number.isInteger(nMarkers) || nMarkers < 1 || nMarkers > 10) {
    throw new Error('Top-N markers must be an integer from 1 to 10.');
  }
}

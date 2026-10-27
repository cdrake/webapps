import { DEFAULT_FOLDS, MODEL_SEEDS, resolveModelChoice } from '../../vendor/seedseg/src/assets.js';

// Maps a `segment` automation request onto a model and its selection. A request that names v1
// checkpoints (`models`) without a `model`, as every request did before v2, still runs v1.
export function segmentRequest({ model, folds, mirror = false, models }) {
  const chosen = resolveModelChoice({ model, folds, mirror, models });
  return chosen === 'v1'
    ? { model: 'v1', models: models ?? MODEL_SEEDS, folds: [], mirror: false }
    : { model: 'v2', models: [], folds: folds ?? DEFAULT_FOLDS, mirror };
}

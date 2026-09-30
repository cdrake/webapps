import manifest from '../../../models/white-matter-lesions.manifest.json';

// The five FLAMeS folds; fold 0 alone is the default, all five are the published ensemble.
export const flamesFolds = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })));

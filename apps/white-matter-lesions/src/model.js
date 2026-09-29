import manifest from '../../../models/white-matter-lesions.manifest.json';

const asset = manifest.assets[0];

export const flamesModel = Object.freeze({ ...asset, url: manifest.base_url + asset.filename });

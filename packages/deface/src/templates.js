// The MNI template and face mask that the allineate methods register, pinned by
// model.manifest.json. The web app fetches them by URL; the command line installs them.
import manifest from '../model.manifest.json' with { type: 'json' };

export const TEMPLATE_ASSETS = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset, url: manifest.base_url + asset.filename })));

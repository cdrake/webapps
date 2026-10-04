import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './apps-registry.mjs';

// Every file a models/*.manifest.json pins by URL, which the desktop must carry offline.
// An asset's own url wins over base_url; manifests with neither resolve assets elsewhere.
export async function modelManifestAssets(root = repoRoot) {
  const directory = join(root, 'models');
  const assets = [];
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.manifest.json')).sort()) {
    const manifest = JSON.parse(await readFile(join(directory, name), 'utf8'));
    for (const asset of Array.isArray(manifest.assets) ? manifest.assets : []) {
      const url = asset.url ?? (manifest.base_url && manifest.base_url + asset.filename);
      if (url) assets.push({ app: manifest.app, manifest: name, name: asset.filename, url, sha256: asset.sha256, bytes: asset.bytes, license: asset.license ?? manifest.license });
    }
  }
  return assets;
}

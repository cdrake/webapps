import { fetchModel } from '../../../components/src/worker/fetchModel.js';
import { createN4Corrector as bindN4Corrector } from './index.js';

export async function createN4Corrector({ baseUrl, manifest, signal, onProgress = () => {}, fetch: fetchAsset = globalThis.fetch }) {
  if (!globalThis.crossOriginIsolated) throw new Error('N4 requires a cross-origin isolated application.');
  const base = new URL(baseUrl, globalThis.location.href);
  if (base.origin !== globalThis.location.origin) throw new Error('N4 runtime must be staged at the same origin as the application.');
  if (manifest?.schema !== 1 || manifest.itk !== '5.4.6' || manifest.files?.length !== 2) throw new Error('Invalid pinned N4 runtime manifest.');
  const assets = new Map();
  for (const record of manifest.files) {
    if (!['nesvor-n4.mjs', 'nesvor-n4.wasm'].includes(record.file) || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Invalid pinned N4 asset identity.');
    const bytes = await fetchModel({ url: new URL(record.file, base).href, integrity: { sha256: record.sha256, bytes: record.bytes } }, {
      signal,
      fetch: (url, options) => fetchAsset(url, { ...options, credentials: 'omit', redirect: 'error' }),
      onProgress: (progress) => onProgress({ stage: 'n4-runtime-download', file: record.file, ...progress }),
    });
    assets.set(record.file, bytes);
  }
  if (assets.size !== 2) throw new Error('N4 runtime manifest must contain both module and WASM.');
  signal?.throwIfAborted();
  const moduleUrl = new URL('nesvor-n4.mjs', base).href;
  const { default: createModule } = await import(/* @vite-ignore */ moduleUrl);
  const module = await createModule({
    wasmBinary: assets.get('nesvor-n4.wasm'),
    locateFile: (file) => new URL(file, base).href,
  });
  signal?.throwIfAborted();
  onProgress({ stage: 'n4-runtime-ready', fraction: 1 });
  return bindN4Corrector(module);
}

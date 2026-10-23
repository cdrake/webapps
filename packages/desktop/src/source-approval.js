import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceGrants } from './source-grants.js';

/** Whether a relative address climbs into the local server's mounts, wherever in the app the page sits. */
function reachesMounts(value) {
  try {
    return decodeURIComponent(new URL(value, 'http://viewer.invalid/app/').pathname).startsWith('/_local/');
  } catch {
    return false;
  }
}

/**
 * What a viewer is asked to load: a local file for an absolute path or file: URL, a remote address for http(s), the
 * address itself for a relative one into the local server's mounts, and nothing to approve for anything else (bundled
 * relative paths, data: and blob: URLs).
 */
export function sourceOf(value) {
  if (value.startsWith('file:')) return { path: fileURLToPath(value) };
  if (isAbsolute(value)) return { path: value };
  const url = URL.parse(value);
  if (!url) return reachesMounts(value) ? { url: value } : null;
  return ['http:', 'https:'].includes(url.protocol) ? { url: url.href } : null;
}

/** Replaces every `url` in a tool's arguments, at any depth, with what `grant` returns for it, one at a time. */
export async function grantSources(value, grant) {
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) items.push(await grantSources(item, grant));
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = key === 'url' && typeof item === 'string' ? await grant(item) : await grantSources(item, grant);
  }
  return result;
}

/**
 * Sources an unattended setup approves in advance: comma-separated absolute directories and http(s) URL prefixes.
 * Anything outside them still needs a person's approval.
 */
export function parseApprovedSources(value) {
  const directories = [];
  const urls = [];
  for (const entry of String(value || '').split(',').map(text => text.trim()).filter(Boolean)) {
    if (isAbsolute(entry)) directories.push(entry);
    else urls.push(entry);
  }
  const grants = createSourceGrants();
  try { grants.add(urls); } catch { throw new Error(`NEURODESK_APPROVED_SOURCES entries must be absolute directories or http(s) URLs: ${urls.join(', ')}`); }
  return {
    /** `file` must already be resolved with realpath. Directories resolve now, so they may be created after startup. */
    async permits({ file, url }) {
      if (url) return grants.permits(url);
      for (const entry of directories) {
        const directory = await realpath(entry).catch(() => null);
        const child = directory && relative(directory, file);
        if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return true;
      }
      return false;
    },
  };
}

/**
 * Decides whether one viewer may load a source, asking `ask` for anything neither its own server (`site`), its grants
 * nor the pre-approved sources cover. An approved URL joins the viewer's grants; an approved file is mounted on the
 * viewer's own server. Returns the address to load and how it was approved.
 */
export function createSourceGranter({ site, grants, approved, ask }) {
  const files = new Map();
  return async ({ path, url }, { base, signal }) => {
    if (url) {
      // Resolved against the viewer's page, as the page itself would resolve it.
      const address = new URL(url, base);
      if (address.origin === site.origin) {
        if (site.owns(address.href)) return { url, approval: 'existing' };
        throw new Error(`${url} is not granted to this viewer. Grant the file by its path.`);
      }
      if (grants.permits(address.href)) return { url, approval: 'existing' };
    }
    const file = path && await realpath(path).catch(() => { throw new Error(`No such file: ${path}`); });
    if (file && !(await stat(file)).isFile()) throw new Error(`Not a file: ${path}`);
    if (file && files.has(file)) return { url: files.get(file), approval: 'existing' };
    let approval = 'configured';
    if (!(await approved.permits({ file, url }))) {
      await ask(file ?? url, signal);
      approval = 'person';
    }
    if (url) {
      grants.add([url]);
      return { url, approval };
    }
    const mounted = await site.mountFile(file);
    files.set(file, mounted);
    return { url: mounted, approval };
  };
}

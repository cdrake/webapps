import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceGrants } from './source-grants.js';

/**
 * What a viewer is asked to load: a local file for an absolute path or file: URL, a remote address for http(s), and
 * nothing to approve for anything else (bundled relative paths, data: and blob: URLs).
 */
export function sourceOf(value) {
  if (value.startsWith('file:')) return { path: fileURLToPath(value) };
  if (isAbsolute(value)) return { path: value };
  let url;
  try { url = new URL(value); } catch { return null; }
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
  try { grants.add('approved', urls); } catch { throw new Error(`NEURODESK_APPROVED_SOURCES entries must be absolute directories or http(s) URLs: ${urls.join(', ')}`); }
  return {
    /** `file` must already be resolved with realpath. Directories resolve now, so they may be created after startup. */
    async permits({ file, url }) {
      if (url) return grants.permits('approved', url);
      for (const entry of directories) {
        const directory = await realpath(entry).catch(() => null);
        const child = directory && relative(directory, file);
        if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return true;
      }
      return false;
    },
  };
}

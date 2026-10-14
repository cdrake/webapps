#!/usr/bin/env node
// Checks that every link the Standalone dialogs offer still resolves: release
// downloads, Apptainer images, Docker Hub tags and OpenRecon recipes in
// registry/standalone.json, and the container records in
// registry/neurocontainers.json they are copied from. Neurocontainers removes a superseded .simg when it
// rebuilds a version, so these links break without any change here; the nightly
// standalone-links workflow runs this rather than pull requests, because the
// result depends on the network, not on the change.
//
//   node scripts/check-standalone-links.mjs [catalog.json ...]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONCURRENCY = 8;
const ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;
const USER_AGENT = 'neurodesk-webapps-link-check (+https://github.com/neurodesk/webapps)';

// The Docker Hub API URL that exists only while `image` (`repo:tag`) is published.
export function dockerHubTagUrl(image) {
  const at = image.indexOf('@');
  const name = at >= 0 ? image.slice(0, at) : image;
  const colon = name.lastIndexOf(':');
  const hasTag = colon > name.lastIndexOf('/');
  const repository = hasTag ? name.slice(0, colon) : name;
  const tag = hasTag ? name.slice(colon + 1) : 'latest';
  const path = repository.includes('/') ? repository : `library/${repository}`;
  return `https://hub.docker.com/v2/repositories/${path}/tags/${encodeURIComponent(tag)}`;
}

// Adds every remote link in `catalog` to `links`, a map from URL to the paths
// (below `root`) that name it, and returns the map. Any https string value counts, so a new URL field is checked without
// changing this; Docker images and OpenRecon recipes are names, so they are
// turned into the URLs that prove they exist.
export function standaloneLinks(catalog, links = new Map(), root = '$') {
  const add = (url, where) => {
    if (!links.has(url)) links.set(url, []);
    links.get(url).push(where);
  };
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (/^https:\/\//.test(value)) add(value, path);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const where = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      if (key === 'dockerImage' && typeof child === 'string') add(dockerHubTagUrl(child), where);
      else if (key === 'openrecon' && child?.recipe) add(`https://github.com/neurodesk/openrecon/tree/main/recipes/${child.recipe}`, `${where}.recipe`);
      walk(child, where);
    }
  };
  walk(catalog, root);
  return links;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const transient = (status) => status === 408 || status === 429 || status >= 500;

async function request(url, method, fetcher) {
  const headers = { 'user-agent': USER_AGENT, ...(method === 'GET' ? { range: 'bytes=0-0' } : {}) };
  const response = await fetcher(url, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  await response.body?.cancel();
  return response.status;
}

// The final status of `url`: HEAD, falling back to a one-byte GET for servers
// that refuse HEAD, retrying network errors and transient statuses.
export async function checkLink(url, { fetcher = fetch, attempts = ATTEMPTS, backoffMs = 5000 } = {}) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let status = await request(url, 'HEAD', fetcher);
      if ([403, 405, 501].includes(status)) status = await request(url, 'GET', fetcher);
      result = { ok: status >= 200 && status < 300, status };
      if (result.ok || !transient(status)) return result;
    } catch (error) {
      result = { ok: false, status: error.cause?.code || error.name || 'error' };
    }
    if (attempt < attempts) await sleep(backoffMs * 2 ** (attempt - 1));
  }
  return result;
}

export async function checkLinks(links, { concurrency = CONCURRENCY, ...options } = {}) {
  const results = new Array(links.length);
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      results[index] = { ...links[index], ...(await checkLink(links[index].url, options)) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, worker));
  return results;
}

async function main() {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const files = process.argv.length > 2 ? process.argv.slice(2) : ['registry/standalone.json', 'registry/neurocontainers.json'];
  const found = new Map();
  for (const file of files) standaloneLinks(JSON.parse(await readFile(resolve(repoRoot, file), 'utf8')), found, file);
  const links = [...found].map(([url, where]) => ({ url, where }));
  const results = await checkLinks(links);
  for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.status} ${result.url}`);
  const failed = results.filter((result) => !result.ok);
  if (!failed.length) {
    console.log(`\nAll ${results.length} Standalone links resolve.`);
    return;
  }
  console.error(`\n${failed.length} of ${results.length} Standalone links do not resolve:`);
  for (const result of failed) {
    console.error(`- ${result.url} (${result.status})`);
    for (const where of result.where) console.error(`    ${where}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

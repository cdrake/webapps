import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry, retryDelay } from '../src/net/fetchWithRetry.js';

const replies = (statuses) => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
    return new Response(status === 200 ? 'bytes' : '', { status, headers: status === 429 ? { 'Retry-After': '0' } : {} });
  };
  return { seen, fetch };
};

test('a 429 is retried until the host answers', async () => {
  const { seen, fetch } = replies([429, 429, 200]);
  const retried = [];
  const response = await fetchWithRetry('https://host/a', {}, { fetch, onRetry: (event) => retried.push(event) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'bytes');
  assert.equal(seen.length, 3);
  assert.deepEqual(retried, [{ status: 429, attempt: 1, delay: 0 }, { status: 429, attempt: 2, delay: 0 }]);
});

test('other errors return at once', async () => {
  const { seen, fetch } = replies([503]);
  const response = await fetchWithRetry('https://host/a', {}, { fetch });
  assert.equal(response.status, 503);
  assert.equal(seen.length, 1);
});

test('retries stop after the limit and return the last 429', async () => {
  const { seen, fetch } = replies([429]);
  const response = await fetchWithRetry('https://host/a', {}, { fetch, retries: 2 });
  assert.equal(response.status, 429);
  assert.equal(seen.length, 3);
});

test('aborting during the wait rejects without another request', async () => {
  const seen = [];
  const fetch = async () => {
    seen.push(1);
    return new Response('', { status: 429, headers: { 'Retry-After': '10' } });
  };
  const controller = new AbortController();
  const pending = fetchWithRetry('https://host/a', { signal: controller.signal }, { fetch });
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(seen.length, 1);
});

test('Retry-After is honoured in seconds and capped; without it the wait backs off', () => {
  const after = (value) => new Response('', { status: 429, headers: { 'Retry-After': value } });
  assert.equal(retryDelay(after('3'), 0), 3000);
  assert.equal(retryDelay(after('600'), 0), 30000);
  const backoff = retryDelay(new Response('', { status: 429 }), 2, { baseDelay: 1000 });
  assert.ok(backoff >= 2000 && backoff <= 4000, `backoff ${backoff}`);
});

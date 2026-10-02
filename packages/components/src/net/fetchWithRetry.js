// Shared hosts such as Hugging Face answer bursts of requests with 429 Too Many Requests.
// Retry those, honouring Retry-After, instead of failing the whole example or volume. Other
// errors, including 503, still fail at once so users see them without waiting.

export function retryDelay(response, attempt, { baseDelay = 1000, maxDelay = 30000 } = {}) {
  const header = response?.headers?.get?.('Retry-After');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), maxDelay);
  }
  return Math.min(baseDelay * 2 ** attempt, maxDelay) * (0.5 + Math.random() / 2);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function fetchWithRetry(input, init = {}, { retries = 4, baseDelay, maxDelay, fetch: fetchImpl = globalThis.fetch, onRetry = () => {} } = {}) {
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(input instanceof Request ? input.clone() : input, init);
    if (response.status !== 429 || attempt >= retries) return response;
    const delay = retryDelay(response, attempt, { baseDelay, maxDelay });
    onRetry({ status: response.status, attempt: attempt + 1, delay });
    await response.body?.cancel().catch(() => {});
    await wait(delay, signal);
  }
}

// MindGrab for web apps, with the published wrapper's `segment` and `segmentTissues`. Each call
// runs in its own module worker (worker.js), which resolves `auto` to a hardware GPU or the
// threaded CPU module (backend.js), so cancelling terminates it and frees its memory.
// Pass `assetPath` pointing at the app's staged copies of the package's dist files.
import { version } from '@brainchop/mindgrab/package.json';

const abortError = (signal) => signal.reason ?? new DOMException('Cancelled', 'AbortError');

function runInWorker(input, tissues, { signal, ...options }) {
  return new Promise((resolve, reject) => {
    const active = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const finish = (error, result) => {
      active.terminate();
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => finish(abortError(signal));
    signal?.addEventListener('abort', cancel, { once: true });
    active.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data.result);
    active.onerror = (event) => finish(new Error(event.message || 'Segmentation worker failed'));
    active.onmessageerror = () => finish(new Error('Segmentation worker returned an unreadable result'));
    if (signal?.aborted) cancel();
    else active.postMessage({ input, tissues, options });
  });
}

/** MindGrab through the published wrapper; `options.signal` cancels a call. */
export const mindgrab = Object.freeze({
  version,
  segment: (input, options) => runInWorker(input, false, options),
  segmentTissues: (input, options) => runInWorker(input, true, options),
});

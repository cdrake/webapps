export function createDicomConverter({ moduleUrl, timeoutMs = 120000 }) {
  if (typeof moduleUrl !== 'string' || !moduleUrl) throw new Error('A DICOM converter module URL is required');
  return async (files, { signal } = {}) => {
    signal?.throwIfAborted();
    let converter;
    let timeout;
    let abort;
    let settled = false;
    try {
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(() => reject(new Error(`dcm2niix timed out after ${timeoutMs} ms`)), timeoutMs);
        void (async () => {
          const { Dcm2niix } = await import(/* @vite-ignore */ moduleUrl);
          signal?.throwIfAborted();
          if (settled) throw new Error('The DICOM conversion has expired');
          converter = new Dcm2niix();
          const initializing = converter.init();
          converter.worker?.addEventListener('error', event => reject(new Error(event.message || 'The DICOM conversion worker failed')));
          await initializing;
          signal?.throwIfAborted();
          if (settled) throw new Error('The DICOM conversion has expired');
          return converter.input(files).run();
        })().then(resolve, reject);
      });
    } finally {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      converter?.worker?.terminate();
    }
  };
}

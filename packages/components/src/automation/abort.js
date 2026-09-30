export async function runAbortable(signal, task, cancel) {
  signal?.throwIfAborted();
  if (!signal) return task();
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => {
        Promise.resolve().then(cancel).then(() => reject(signal.reason), () => reject(signal.reason));
      };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(task).then(value => {
        if (!signal.aborted) resolve(value);
      }, reject);
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

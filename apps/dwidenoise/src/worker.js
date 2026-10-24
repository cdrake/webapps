// One Patch2Self worker: loads the WebAssembly once, then handles one voxel chunk or one volume
// solve per message (worker-tasks.js lists the messages). gzip-worker.js compresses the output.
import { loadDwidenoise } from "@neurodesk/dwidenoise";
import wasmUrl from "@neurodesk/dwidenoise/wasm?url";
import { createWorkerTasks } from "./worker-tasks.js";

const ready = loadDwidenoise(fetch(wasmUrl)).then(createWorkerTasks);
// A load failure is reported in the reply to each message. This keeps it from being an
// unhandled rejection when the page stops the worker before it sends a message.
ready.catch(() => {});

self.onmessage = async ({ data: message }) => {
  let handle;
  try {
    handle = await ready;
  } catch (error) {
    self.postMessage({ id: message.id, error: error?.message ?? String(error) });
    return;
  }
  const reply = handle(message);
  if (reply) self.postMessage(...reply);
};

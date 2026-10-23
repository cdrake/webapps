// One Patch2Self worker: loads the WebAssembly once, then handles one voxel chunk or one volume
// solve per message (worker-tasks.js lists the messages). { type: "gzip", buffer } compresses
// the output file off the page's thread and answers { data }.
import { loadDwidenoise } from "@neurodesk/dwidenoise";
import wasmUrl from "@neurodesk/dwidenoise/wasm?url";
import { createWorkerTasks } from "./worker-tasks.js";

const ready = loadDwidenoise(fetch(wasmUrl)).then(createWorkerTasks);
const GZIP_SLICE = 1 << 24;

/** Compresses from 16 MB slices of the buffer, so no second uncompressed copy is made. */
async function gzip(buffer) {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(offset + GZIP_SLICE, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

self.onmessage = async ({ data: message }) => {
  if (message.type === "gzip") {
    try {
      const data = await gzip(message.buffer);
      self.postMessage({ data }, [data]);
    } catch (error) {
      self.postMessage({ error: error?.message ?? String(error) });
    }
    return;
  }
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

// One degibbs worker: loads the WebAssembly once, then corrects one volume per message.
// In: { id, data, dims, axes }. Out: { id, data } or { id, error }.
import { loadDegibbs } from "@neurodesk/degibbs";
import wasmUrl from "@neurodesk/degibbs/wasm?url";

const ready = loadDegibbs(fetch(wasmUrl));

self.onmessage = async ({ data: message }) => {
  try {
    const { degibbs } = await ready;
    const out = degibbs(message.data, message.dims, 1, { axes: message.axes });
    self.postMessage({ id: message.id, data: out }, [out.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: error?.message ?? String(error) });
  }
};

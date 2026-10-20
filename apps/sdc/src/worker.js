// The sdc worker: loads the WebAssembly once and runs one PyHySCO estimate per message. The page
// cancels a run by terminating the worker.
import { loadSdc } from "@neurodesk/sdc";
import wasmUrl from "@neurodesk/sdc/wasm?url";

const ready = loadSdc(fetch(wasmUrl));

self.onmessage = async ({ data: message }) => {
  try {
    const { pyhysco } = await ready;
    const out = pyhysco(message.image1, message.image2, message.dims, message.voxel, message.options);
    self.postMessage({ ok: true, ...out }, [out.field.buffer, out.corrected1.buffer, out.corrected2.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: error?.message ?? String(error) });
  }
};

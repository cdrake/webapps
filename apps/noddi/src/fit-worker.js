// One fitting worker: loads the noddi WebAssembly once, then fits chunks of masked voxels.
// Messages in: { type: "init", bvals, bvecs, weighted, noddi } then { type: "fit", id, data, voxels }.
// Messages out: { type: "ready" }, { type: "done", id, tensor, noddi } or { type: "error", message }.
import { loadNoddi } from "@neurodesk/noddi";
import wasmUrl from "@neurodesk/noddi/wasm?url";

let api = null;
let model = null;
let settings = null;

function transferables(maps) {
  return maps ? Object.values(maps).map((values) => values.buffer) : [];
}

self.onmessage = async ({ data: message }) => {
  try {
    if (message.type === "init") {
      api = await loadNoddi(fetch(wasmUrl));
      settings = message;
      model = message.noddi ? api.noddiModel(message.bvals, message.bvecs) : null;
      self.postMessage({ type: "ready" });
      return;
    }
    if (message.type === "fit") {
      const { bvals, bvecs, weighted } = settings;
      const tensor = api.dtiFit(message.data, message.voxels, bvals, bvecs, { weighted });
      const noddi = model ? model.fit(message.data, message.voxels) : null;
      self.postMessage({ type: "done", id: message.id, tensor, noddi }, [...transferables(tensor), ...transferables(noddi)]);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error) });
  }
};

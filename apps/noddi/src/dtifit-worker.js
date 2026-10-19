// The niimath dtifit worker: one fit per worker.
// Message in: the fitDtifit input. Messages out: { type: "done", tensor } or { type: "error", message }.
import { runNiimath } from "@neurodesk/dwi2trx/runner";
import { fitDtifit } from "./dtifit.js";

self.onmessage = async ({ data: message }) => {
  try {
    const tensor = await fitDtifit(runNiimath, message);
    self.postMessage({ type: "done", tensor }, Object.values(tensor).map((values) => values.buffer));
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error) });
  }
};

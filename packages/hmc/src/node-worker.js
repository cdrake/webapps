// One registration worker thread of the command line: the hmc-registration kernel (pinned by
// SHA-256) behind the same messages as its browser module worker,
// { id, argv, inputs } -> { id, outputs, log } or { id, error, log }.
// The kernel is loaded once and serves every later run; after a run aborts it, the next
// message loads a new one.
import { parentPort } from "node:worker_threads";
import { loadHmcRegistration } from "@neurodesk/hmc-registration/node";

let kernel = null;

parentPort.on("message", async ({ id, argv, inputs = {} }) => {
  try {
    kernel ??= loadHmcRegistration().catch((error) => {
      kernel = null;
      throw error;
    });
    const { outputs, log } = (await kernel).run(argv, inputs);
    const buffers = new Set(Object.values(outputs).map((bytes) => bytes.buffer));
    parentPort.postMessage({ id, outputs, log }, [...buffers]);
  } catch (error) {
    if (error?.aborted) kernel = null;
    parentPort.postMessage({ id, error: error?.message ?? String(error), log: Array.isArray(error?.log) ? error.log : [] });
  }
});

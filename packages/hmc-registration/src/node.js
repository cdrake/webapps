// Loads the antsRegistration WebAssembly kernel in Node after checking it is the pinned build.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createHmcRegistration } from "./index.js";
import { HMC_REGISTRATION_WASM_SHA256 } from "./pin.js";

// Bundlers that copy the kernel elsewhere pass their own locations.
export const KERNEL = Object.freeze({
  module: new URL("../wasm/hmc-registration.mjs", import.meta.url),
  wasm: new URL("../wasm/hmc-registration.wasm", import.meta.url),
});

export async function readHmcRegistrationWasm(wasm = KERNEL.wasm) {
  const bytes = await readFile(wasm);
  if (createHash("sha256").update(bytes).digest("hex") !== HMC_REGISTRATION_WASM_SHA256) throw new Error("Registration WebAssembly checksum mismatch.");
  return bytes;
}

export async function loadHmcRegistration({ module = KERNEL.module, wasm = KERNEL.wasm, onLog } = {}) {
  const wasmBinary = await readHmcRegistrationWasm(wasm);
  const { default: createModule } = await import(module);
  if (typeof createModule !== "function") throw new Error("Registration module did not load.");
  return createHmcRegistration({ createModule, wasmBinary, onLog });
}

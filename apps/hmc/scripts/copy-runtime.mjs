import { cp, mkdir } from "node:fs/promises";

const destination = new URL("../public/registration/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ["hmc-registration.mjs", "hmc-registration.wasm"]) {
  await cp(new URL(`../../../packages/hmc-registration/wasm/${name}`, import.meta.url), new URL(name, destination));
}

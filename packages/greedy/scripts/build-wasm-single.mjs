// Builds the committed single-threaded Greedy WebAssembly (wasm-single/) that SYNcro's command line
// runs in Node. LLVM folds math constants with the host's libm, so it is built on Linux with the threaded
// build's pinned nightly and wasm-pack 0.13.1, and committed: every platform then runs the same bytes.
// --check rebuilds and fails when the committed files differ.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const crate = fileURLToPath(new URL("../../../exes/greedy/wasm", import.meta.url));
const committed = fileURLToPath(new URL("../wasm-single", import.meta.url));
const target = fileURLToPath(new URL("../../../exes/greedy/target/wasm-single", import.meta.url));
const FILES = ["greedy_rs_wasm.js", "greedy_rs_wasm_bg.wasm"];
const check = process.argv.includes("--check");

const output = mkdtempSync(join(tmpdir(), "greedy-wasm-single-"));
try {
  execFileSync("rustup", [
    "run",
    "nightly-2025-11-15",
    "wasm-pack",
    "build",
    crate,
    "--target",
    "web",
    "--release",
    "--out-dir",
    output,
    "--out-name",
    "greedy_rs_wasm",
    "--no-pack",
    "--",
    "--no-default-features",
  ], { stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target } });
  const stale = [];
  for (const file of FILES) {
    let bytes = readFileSync(join(output, file));
    if (file.endsWith(".js")) bytes = Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"));
    if (!check) writeFileSync(join(committed, file), bytes);
    else if (!bytes.equals(readFileSync(join(committed, file)))) stale.push(file);
  }
  if (stale.length) {
    console.error(`These committed files differ from a rebuild: ${stale.join(", ")}. Run pnpm --filter @neurodesk/greedy build:wasm-single on Linux and commit the result.`);
    process.exitCode = 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}

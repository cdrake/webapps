// antsRegistration in WebAssembly with a generic run(argv): the input files are written to a
// private directory of the virtual file system, the kernel runs there, every new file is read
// back, and the directory is removed.

export { HMC_REGISTRATION_WASM_SHA256 } from "./pin.js";
export { readMatTransform } from "./mat.js";

const MAX_SEED = 2147483647;

function valueOf(argv, flag) {
  const positions = [];
  argv.forEach((token, index) => {
    if (token === flag) positions.push(index);
  });
  if (positions.length !== 1) return { count: positions.length };
  return { count: 1, value: argv[positions[0] + 1] };
}

/**
 * Refuses argv that this build must not run. The kernel has only the 3D float implementation, so
 * `--float 1` is required. ANTs seeds from the clock when no seed is given, so an explicit
 * `--random-seed` (an integer from 1 to 2147483647) is required too.
 */
export function checkArguments(argv) {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) throw new TypeError("argv must be an array of strings.");
  const float = valueOf(argv, "--float");
  if (float.count !== 1 || float.value !== "1") {
    throw new Error("This build runs only antsRegistration --float 1: give --float 1 exactly once.");
  }
  const seed = valueOf(argv, "--random-seed");
  const seedValue = seed.value ?? "";
  if (seed.count !== 1 || !/^[1-9][0-9]*$/.test(seedValue) || Number(seedValue) > MAX_SEED) {
    throw new Error("Give --random-seed exactly once, with an integer from 1 to 2147483647: without it ANTs seeds from the clock.");
  }
  return argv;
}

function checkName(name) {
  if (!/^[^/\0]+$/.test(name) || name === "." || name === "..") throw new Error(`Input names must be plain file names: ${JSON.stringify(name)}.`);
}

function removeTree(FS, path) {
  for (const name of FS.readdir(path)) {
    if (name === "." || name === "..") continue;
    const child = `${path}/${name}`;
    if (FS.isDir(FS.stat(child).mode)) removeTree(FS, child);
    else FS.unlink(child);
  }
  FS.rmdir(path);
}

export async function createHmcRegistration({ createModule, wasmBinary, onLog = () => {} }) {
  let lines = null;
  const log = (line) => {
    lines?.push(line);
    onLog(line);
  };
  const module = await createModule({ noInitialRun: true, wasmBinary });
  // The ITK-Wasm toolchain's pre-js replaces print and printErr with functions that write to the
  // console and append to a string that grows with every run. While the synchronous kernel runs,
  // the console is routed to the run's log, and the strings are emptied before each run.
  function callMain(argv) {
    module.resetModuleStdout?.();
    module.resetModuleStderr?.();
    const { log: consoleLog, error: consoleError } = console;
    let forwarding = false;
    console.log = console.error = (...args) => {
      // An onLog that writes to the console reaches the real console, not this function again.
      if (forwarding) return consoleLog(...args);
      forwarding = true;
      try {
        log(args.join(" "));
      } finally {
        forwarding = false;
      }
    };
    try {
      return module.callMain(argv);
    } finally {
      console.log = consoleLog;
      console.error = consoleError;
    }
  }
  let next = 0;
  let stopped = null;
  return {
    /**
     * Runs antsRegistration with `argv` inside a new directory that holds `inputs`, so argv names
     * files relative to it. A .nii.gz input is read as gzipped NIfTI, as ANTs picks the reader by
     * file name.
     * @param {string[]} argv the antsRegistration arguments, without the program name
     * @param {Record<string, Uint8Array|ArrayBuffer>} inputs file name to bytes
     * @returns {{ outputs: Record<string, Uint8Array>, log: string[] }} every file the run wrote
     */
    run(argv, inputs = {}) {
      checkArguments(argv);
      if (stopped) throw new Error(`The registration kernel stopped (${stopped}); load a new one.`);
      for (const name of Object.keys(inputs)) checkName(name);
      const dir = `/run-${next++}`;
      lines = [];
      const runLog = lines;
      module.FS.mkdir(dir);
      try {
        for (const [name, bytes] of Object.entries(inputs)) module.FS.writeFile(`${dir}/${name}`, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        module.FS.chdir(dir);
        let code;
        try {
          code = callMain(argv);
        } catch (error) {
          stopped = error?.message ?? String(error);
          throw new Error(`antsRegistration aborted: ${stopped}`, { cause: error });
        }
        if (code !== 0) throw new Error(`antsRegistration failed (exit ${code}): ${runLog.slice(-5).join(" ")}`);
        const outputs = {};
        for (const name of module.FS.readdir(dir)) {
          if (name === "." || name === ".." || Object.hasOwn(inputs, name)) continue;
          const path = `${dir}/${name}`;
          if (module.FS.isFile(module.FS.stat(path).mode)) outputs[name] = module.FS.readFile(path);
        }
        return { outputs, log: runLog };
      } finally {
        lines = null;
        try {
          module.FS.chdir("/");
          removeTree(module.FS, dir);
        } catch {
          // An aborted kernel can leave the file system unusable; the run's own error is kept.
        }
      }
    },
    memoryBytes: () => module.HEAPU8?.byteLength ?? null,
  };
}

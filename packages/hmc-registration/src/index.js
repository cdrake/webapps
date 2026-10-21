// ANTs (antsRegistration, AverageImages, AverageAffineTransform and an antsApplyTransforms-style
// --apply) in WebAssembly with a generic run(argv): the input files are written to a private
// directory of the virtual file system, the kernel runs there, every new file is read back, and
// the directory is removed.

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

/** The programs other than antsRegistration, selected by argv[0], as src/main.cxx dispatches them. */
export const PROGRAMS = Object.freeze(["AverageImages", "AverageAffineTransform", "--apply"]);

/** The program argv runs: argv[0] when it is one of PROGRAMS, else antsRegistration. */
export function programOf(argv) {
  return PROGRAMS.includes(argv?.[0]) ? argv[0] : "antsRegistration";
}

/**
 * Refuses argv that this build must not run. For antsRegistration (the default program), the
 * kernel has only the 3D float implementation, so `--float 1` is required, and ANTs seeds from
 * the clock when no seed is given, so an explicit `--random-seed` (an integer from 1 to
 * 2147483647) is required too. AverageImages, AverageAffineTransform and --apply take file names
 * as positional arguments, so none of their arguments may hold a directory.
 */
export function checkArguments(argv) {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) throw new TypeError("argv must be an array of strings.");
  const program = programOf(argv);
  if (program !== "antsRegistration") {
    for (const token of argv.slice(1)) {
      if (token.includes("/") || token.includes("\0") || token === "..") {
        throw new Error(`${program} arguments must be plain file names inside the private run directory: ${JSON.stringify(token)}.`);
      }
    }
    return argv;
  }
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

// The input files each program reads, from its positional arguments.
function inputNames(program, argv) {
  if (program === "--apply") return [argv[1], argv[2], ...argv.slice(6).map((name) => name.replace(/^inverse:/, ""))];
  if (program === "AverageImages") return argv.slice(4);
  if (program === "AverageAffineTransform") {
    // AverageAffineTransform dim output [-R reference] {[-i] transform [weight]}...
    return argv.slice(3).filter((token, i, rest) => token !== "-R" && token !== "-i" && (rest[i - 1] === "-R" || !/^[-+]?[0-9.]+(e[-+]?[0-9]+)?$/i.test(token)));
  }
  return [];
}

// The kernel is built without C++ exception catching, so an ITK reader that fails on a missing
// file aborts it. For AverageImages, AverageAffineTransform and --apply, every input argv names
// must be among the inputs.
function checkInputsPresent(program, argv, inputs) {
  for (const name of inputNames(program, argv)) {
    if (name !== undefined && !Object.hasOwn(inputs, name)) throw new Error(`${program} reads ${JSON.stringify(name)}, which is not among the inputs.`);
  }
}

function checkName(name) {
  if (!/^[^/\0]+$/.test(name) || name === "." || name === "..") throw new Error(`Input names must be plain file names: ${JSON.stringify(name)}.`);
}

// ANTs aborts the kernel, rather than exiting non-zero, when an output prefix names a directory
// that does not exist, so that mistake is refused here with a clear message.
function checkOutputDirectories(FS, argv) {
  argv.forEach((token, index) => {
    if (token !== "--output" && token !== "-o") return;
    const value = argv[index + 1] ?? "";
    for (const piece of value.replace(/^\[|\]$/g, "").split(",")) {
      if (piece.startsWith("/") || piece.split("/").includes("..") || piece.includes("\0")) {
        throw new Error(`Output paths must stay inside the private run directory: ${JSON.stringify(piece)}.`);
      }
      const slash = piece.lastIndexOf("/");
      if (slash <= 0) continue;
      const parent = piece.slice(0, slash);
      let exists = false;
      try {
        exists = FS.isDir(FS.stat(parent).mode);
      } catch {
        exists = false;
      }
      if (!exists) throw new Error(`The output directory ${JSON.stringify(parent)} does not exist: give output names without a directory.`);
    }
  });
}

function failure(message, runLog, { aborted = false, cause } = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.log = runLog;
  error.aborted = aborted;
  return error;
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
     * Runs an ANTs program with `argv` inside a new directory that holds `inputs`, so argv names
     * files relative to it. A .nii.gz input is read as gzipped NIfTI, as ANTs picks the reader by
     * file name. argv[0] selects AverageImages, AverageAffineTransform or --apply (see PROGRAMS);
     * any other argv is antsRegistration's, without the program name.
     * @param {string[]} argv the program's arguments
     * @param {Record<string, Uint8Array|ArrayBuffer>} inputs file name to bytes
     * @returns {{ outputs: Record<string, Uint8Array>, log: string[] }} every file the run wrote
     * @throws {Error} with `log` (the run's log) and `aborted` (true when the kernel trapped; this
     * instance then refuses later runs and a new one must be loaded)
     */
    run(argv, inputs = {}) {
      checkArguments(argv);
      const program = programOf(argv);
      if (stopped) throw failure(`The registration kernel stopped (${stopped}); load a new one.`, [], { aborted: true });
      for (const name of Object.keys(inputs)) checkName(name);
      checkInputsPresent(program, argv, inputs);
      const dir = `/run-${next++}`;
      lines = [];
      const runLog = lines;
      module.FS.mkdir(dir);
      try {
        for (const [name, bytes] of Object.entries(inputs)) module.FS.writeFile(`${dir}/${name}`, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        module.FS.chdir(dir);
        if (program === "antsRegistration") checkOutputDirectories(module.FS, argv);
        let code;
        try {
          code = callMain(argv);
        } catch (error) {
          // The kernel trapped (for example on an input file that is not there). Its state is
          // lost, so this instance refuses later runs; the log holds the cause.
          stopped = error?.message ?? String(error);
          throw failure(`${program} aborted (${stopped}): ${runLog.slice(-5).join(" ")}`, runLog, { aborted: true, cause: error });
        }
        if (code !== 0) throw failure(`${program} failed (exit ${code}): ${runLog.slice(-5).join(" ")}`, runLog);
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

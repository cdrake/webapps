// Runs one niimath argv in the vendored build's WebAssembly worker, over named in-memory files.
// The browser twin of runNiimath in @neurodesk/node-drivers/niimath: a caller that builds its own
// argv runs the same command in the browser and under Node. The fluent Niimath wrapper renames
// its operands, so it cannot give the two the same argv.

/**
 * @returns {{ run(args: string[], files: { inputs: Record<string, Uint8Array>, output: string }): Promise<Uint8Array>, dispose(): void }}
 */
export function createNiimathCommand() {
  let worker = null;
  let ready = null;

  function start() {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const current = worker;
    ready = new Promise((resolve, reject) => {
      current.onmessage = ({ data }) => {
        if (data?.type === 'ready') resolve();
      };
      current.onerror = (event) => reject(new Error(`niimath worker failed to load: ${event.message}`));
    });
    return ready;
  }

  // A failed or abandoned run can leave the module's heap and file system in an unknown state,
  // so the next run starts a fresh worker.
  function dispose() {
    worker?.terminate();
    worker = null;
    ready = null;
  }

  async function run(args, { inputs, output }) {
    const [first, ...rest] = Object.entries(inputs);
    if (!first) throw new Error('niimath needs at least one input file.');
    await (ready ?? start());
    const current = worker;
    return new Promise((resolve, reject) => {
      current.onmessage = ({ data }) => {
        if (data?.type === 'error') {
          dispose();
          reject(new Error(data.message));
        } else if (data && 'blob' in data) {
          data.blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
        }
      };
      current.postMessage({
        blob: new File([first[1]], first[0]),
        cmd: [...args],
        outName: output,
        extraFiles: rest.map(([name, bytes]) => ({ name, data: new Blob([bytes]) })),
      });
    });
  }

  return { run, dispose };
}

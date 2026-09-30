// Glue for ./lcmodel.wasm (see ../wasm/src/lib.rs): a plain C ABI, no wasm-bindgen.
// One call runs LCModel: JSON request in, JSON reply out. Views of wasm memory are
// re-taken after each export call, because a heap growth detaches the old buffer.

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadLcmodel(source) {
  const wasm = await instantiate(await source);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    /**
     * Run LCModel.
     * @param {{control: string, files: Record<string, string>, fdate?: string}} request
     *   `control` is the LCMODL namelist; `files` maps the names it references
     *   (FILRAW, FILH2O, FILBAS) to their text.
     * @returns {{outputs: Record<string, string>, stdout: string, error: string | null}}
     */
    run(request) {
      const bytes = encoder.encode(JSON.stringify({ fdate: "", ...request }));
      const ptr = wasm.alloc(bytes.length);
      new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
      wasm.lcmodel_run(ptr, bytes.length);
      wasm.dealloc(ptr, bytes.length);
      const out = new Uint8Array(wasm.memory.buffer, wasm.reply_ptr(), wasm.reply_len());
      return JSON.parse(decoder.decode(out));
    },
  };
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}

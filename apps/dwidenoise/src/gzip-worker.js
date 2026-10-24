// Compresses the output file off the page's thread. It loads no WebAssembly.
// In: { type: "gzip", buffer } (the buffer is transferred).
// Out: { data } (the gzip bytes, transferred) or { error }.
const GZIP_SLICE = 1 << 24;

/** Compresses from 16 MB slices of the buffer, so no second uncompressed copy is made. */
async function gzip(buffer) {
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(offset + GZIP_SLICE, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  return new Response(source.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}

self.onmessage = async ({ data: message }) => {
  try {
    const data = await gzip(message.buffer);
    self.postMessage({ data }, [data]);
  } catch (error) {
    self.postMessage({ error: error?.message ?? String(error) });
  }
};

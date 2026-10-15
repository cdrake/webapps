// The web app's MindGrab and niimath runtimes, shaped for pipeline.js. MindGrab is the shared
// browser runtime: each segmentation runs in its own module worker, so cancelling terminates it.
import { Niimath } from '@niivue/niimath';

export { mindgrab } from '@neurodesk/runtime-support/mindgrab';

/** niimath's mesh in its WebAssembly worker. `mesh(bytes, options, signal)` resolves to the mz3. */
export function createNiimathMesher() {
  const niimath = new Niimath();
  let ready = null;
  async function mesh(segmentation, options, signal) {
    const cancel = () => niimath.dispose('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      ready ??= niimath.init();
      await ready;
      signal?.throwIfAborted();
      const output = await niimath
        .image(new File([segmentation], 'segmentation.nii'))
        .mesh(options)
        .run('brain.mz3');
      signal?.throwIfAborted();
      return new Uint8Array(await output.arrayBuffer());
    } catch (error) {
      dispose('mesh failed');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  // A disposed worker is started afresh by the next mesh.
  function dispose(reason) {
    niimath.dispose(reason);
    ready = null;
  }
  return { mesh, dispose };
}

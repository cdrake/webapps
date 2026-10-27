export async function runWithFallback({ backend, createSession, execute, onFallback }) {
  for (const provider of backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']) {
    let session;
    try {
      session = await createSession(provider);
      return { result: await execute(session), backend: provider };
    } catch (error) {
      if (provider !== 'webgpu') throw error;
      onFallback(error);
    } finally {
      await session?.release();
    }
  }
}

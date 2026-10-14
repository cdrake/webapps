// Vite's HMR client awaits the promise a dispose callback returns before it imports the
// updated module (fetchUpdate in vite/dist/client/client.mjs); its published type says void.
// Deface's teardown releases GPU devices and workers, so the new module must wait for it.
import 'vite/types/hot.d.ts'

declare module 'vite/types/hot.d.ts' {
  interface ViteHotContext {
    dispose(cb: (data: unknown) => Promise<void>): void
  }
}

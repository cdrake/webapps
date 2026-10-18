import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs'

// The explicit relative base keeps the standalone release zip hostable at any
// path (its legacy home was niivue.github.io/niivue-niimath); the composite
// serves it under /niimath/ and relative URLs resolve there too.
export default neurodeskViteConfig({
  appId: 'niimath',
  base: './',
  root: '.',
  build: {
    rollupOptions: {
      output: {
        format: 'es'
      }
    }
  },
  // exclude @niivue/niimath from optimization
  optimizeDeps: {
    exclude: ['@niivue/niimath']
  }
})

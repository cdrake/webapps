// The only module that loads nv-mcp's browser client. Its file name names the lazy chunk each app bundle emits
// (`nv-mcp-<hash>.js`), which the composite site serves once from its runtime store (runtime-assets/manifest.json).
export { AgentClient, coreHandlers, sceneState } from '@niivue/nv-mcp/browser';

---
---

Declare test and validation tooling (Playwright, jsdom, Ajv, Vite, yaml, ONNX Runtime Node) in the workspaces that import it, and import Vite by name in NeSVoR's workflow verifier. The dependency checker now rejects relative paths into another workspace's or the root's `node_modules`, `createRequire` anchored in another workspace, and tooling imports their workspace does not declare.

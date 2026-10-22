---
"pipelines": minor
---

New Pipeline Builder app: chain the web apps' operations into a NeuroFlow workflow document. Inputs bind to earlier outputs whose type fits, the workflow is checked as you edit by the NeuroFlow core compiled to WebAssembly (the validator neuroflow-mcp runs), and Export downloads the `.workflow.json`. The page computes nothing. Its build also publishes the catalog's generated tools and a `neuroflow-registry.json` under the page's path, so NeuroFlow clients can load the catalog by URL.
